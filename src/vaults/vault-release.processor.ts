import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VaultsService } from './vaults.service';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { VaultStatus, LedgerEntryType, TransactionStatus } from '../domain/enums';
import { ethers } from 'ethers';
import { calculateDayleFee } from '../common/utils/fee.utils';
import { RedisService } from '../common/redis/redis.service';

@Processor('vault-release', {
  concurrency: 1,
  stalledInterval: 300000,
  lockDuration: 300000,
  drainDelay: 30000,
})
export class VaultReleaseProcessor extends WorkerHost {
  private readonly logger = new Logger(VaultReleaseProcessor.name);

  constructor(
    private vaultsService: VaultsService,
    private prisma: PrismaService,
    private blockchainService: BlockchainService,
    private redisService: RedisService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { vaultId, userId } = job.data;
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) throw new Error(`Vault ${vaultId} not found`);

    const budgetUSD = parseFloat(
      ethers.formatUnits(
        vault.totalAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
    );
    const fees = calculateDayleFee(budgetUSD);

    try {
      // 1. Database Transaction
      const result = await this.prisma.$transaction(async (tx) => {
        const updatedVault = await tx.vault.update({
          where: { id: vaultId },
          data: {
            status: VaultStatus.RELEASED as any,
            settlementFeeUSD: fees.settlementFeeUSD,
            totalFeeUSD: fees.totalFeeUSD,
            freelancerReceivesUSD: fees.freelancerReceivesUSD,
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: vault.freelancerId!,
            vaultId: vault.id,
            type: LedgerEntryType.RELEASE,
            amount: ethers.parseUnits(
              fees.freelancerReceivesUSD.toString(),
              vault.tokenDecimals,
            ),
            currency: vault.tokenSymbol || 'USD',
            status: TransactionStatus.CONFIRMED,
            description: `Release for vault: ${vault.title} (Net of fees)`,
            completedAt: new Date(),
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: vault.freelancerId!,
            vaultId: vault.id,
            type: LedgerEntryType.LOCK,
            amount: -vault.totalAmount,
            currency: vault.tokenSymbol || 'USD',
            status: TransactionStatus.CONFIRMED,
            description: `Locked funds resolved for vault: ${vault.title}`,
            completedAt: new Date(),
          },
        });

        await tx.ledgerEntry.create({
          data: {
            userId: vault.clientId,
            vaultId: vault.id,
            type: LedgerEntryType.FEE,
            amount: ethers.parseUnits(
              fees.totalFeeUSD.toString(),
              vault.tokenDecimals,
            ),
            currency: vault.tokenSymbol || 'USD',
            status: TransactionStatus.CONFIRMED,
            description: `Platform fee for vault: ${vault.title}`,
            completedAt: new Date(),
          },
        });

        return updatedVault;
      });

      // 2. Blockchain Release
      if (vault.vaultAddress) {
        await this.blockchainService.releaseVault(
          vault.vaultAddress,
          fees.totalFeeBasisPoints,
        );
      }

      // 3. Invalidate Cache
      try {
        await this.vaultsService.invalidateVaultCache(
          vault.id,
          vault.clientId,
          vault.freelancerId,
        );
      } catch (cacheErr) {
        this.logger.error(`[RELEASE SUCCESS] Failed to invalidate cache`, cacheErr);
      }

      // 4. Publish for Real-time
      try {
        await this.redisService.publish('vault.released', {
          vaultId,
          clientId: vault.clientId,
          freelancerId: vault.freelancerId,
          title: vault.title,
        });
      } catch (redisErr) {
        this.logger.error(`[RELEASE SUCCESS] Failed to publish redis event`, redisErr);
      }

      this.logger.log(`[RELEASE SUCCESS] Vault ${vaultId} released successfully`);
      return { success: true };
    } catch (error) {
      this.logger.error(`[RELEASE FAILED] Vault ${vaultId}: ${error.message}`);
      
      if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
        this.logger.error(`[ADMIN ALERT] Release failed for vault ${vaultId} after max attempts`);
        await this.prisma.vault.update({
          where: { id: vaultId },
          data: { status: VaultStatus.RELEASE_FAILED },
        });
      }
      throw error;
    }
  }
}
