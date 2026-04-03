import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VaultsService } from './vaults.service';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { VaultStatus, LedgerEntryType, TransactionStatus } from '../domain/enums';

@Processor('vault-refund')
export class VaultRefundProcessor extends WorkerHost {
  private readonly logger = new Logger(VaultRefundProcessor.name);

  constructor(
    private vaultsService: VaultsService,
    private prisma: PrismaService,
    private blockchainService: BlockchainService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { vaultId, userId } = job.data;
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) throw new Error(`Vault ${vaultId} not found`);

    try {
      // 1. Database Transaction
      await this.prisma.$transaction(async (tx) => {
        await tx.vault.update({
          where: { id: vaultId },
          data: { status: VaultStatus.REFUNDED as any },
        });

        await tx.ledgerEntry.create({
          data: {
            userId,
            vaultId: vault.id,
            type: LedgerEntryType.REFUND,
            amount: vault.totalAmount,
            currency: vault.tokenSymbol || 'USD',
            status: TransactionStatus.CONFIRMED,
            description: `Refund for vault: ${vault.title}`,
            completedAt: new Date(),
          },
        });
      });

      // 2. Blockchain Refund
      if (vault.vaultAddress) {
        await this.blockchainService.refundVault(vault.vaultAddress);
      }

      this.logger.log(`[REFUND SUCCESS] Vault ${vaultId} refunded successfully`);
      return { success: true };
    } catch (error) {
      this.logger.error(`[REFUND FAILED] Vault ${vaultId}: ${error.message}`);
      
      if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
        this.logger.error(`[ADMIN ALERT] Refund failed for vault ${vaultId} after max attempts`);
        await this.prisma.vault.update({
          where: { id: vaultId },
          data: { status: VaultStatus.REFUND_FAILED },
        });
      }
      throw error;
    }
  }
}
