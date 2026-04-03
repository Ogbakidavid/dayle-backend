import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { VaultsService } from './vaults.service';
import { Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { PartnaService } from '../common/services/partna.service';
import { RatesService } from '../rates/rates.service';
import { VaultStatus } from '../domain/enums';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

@Processor('vault-withdrawal')
export class VaultWithdrawalProcessor extends WorkerHost {
  private readonly logger = new Logger(VaultWithdrawalProcessor.name);

  constructor(
    private vaultsService: VaultsService,
    private prisma: PrismaService,
    private paycrestService: PaycrestService,
    private blockchainService: BlockchainService,
    private partnaService: PartnaService,
    private ratesService: RatesService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { vaultId, userId, bankDetails } = job.data;
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { freelancer: { include: { wallet: true } } },
    });

    if (!vault || !vault.freelancer) {
      throw new Error(`Vault ${vaultId} or freelancer not found`);
    }

    const amountUSD = Number(vault.freelancerReceivesUSD || 0) * 0.995;
    const currency = vault.freelancer.country === 'Kenya' ? 'KES' : 'NGN';
    const network = currency === 'KES' ? 'mpesa' : 'naira';
    const rampReference = crypto.randomBytes(16).toString('hex');

    try {
      // 1. Try Paycrest
      this.logger.log(`[PAYCREST] Starting withdrawal for vault ${vaultId}`);
      const rateResponse = await this.paycrestService.getExchangeRate(amountUSD, currency);
      const rate = parseFloat(rateResponse.data);

      const orderResponse = await this.paycrestService.createOrder({
        amount: amountUSD,
        currency,
        customerEmail: vault.freelancer.email,
        reference: rampReference,
        vaultId,
        rate,
        bankDetails: {
          account_number: bankDetails.accountNumber,
          bank_code: bankDetails.bankCode,
          account_name: bankDetails.accountName,
        },
      });

      const receiveAddress = orderResponse.receiveAddress;
      if (!receiveAddress) throw new Error('No receive address from Paycrest');

      const amountWei = ethers.parseUnits(amountUSD.toString(), vault.tokenDecimals);
      await this.blockchainService.transferTreasuryToken(receiveAddress, amountWei, vault.tokenAddress);

      await this.prisma.vault.update({
        where: { id: vaultId },
        data: {
          status: VaultStatus.WITHDRAWAL_PENDING,
          paycrestOrderId: orderResponse.id,
          paycrestReceiveAddress: receiveAddress,
          paycrestValidUntil: orderResponse.validUntil ? new Date(orderResponse.validUntil) : null,
          paycrestRate: rate,
          paycrestOrderCreatedAt: new Date(),
        },
      });

      return { success: true, provider: 'paycrest' };
    } catch (paycrestError) {
      this.logger.warn(`Paycrest failed, falling back to Partna: ${paycrestError.message}`);

      try {
        // 2. Partna Fallback
        const { rate, rateKey } = await this.ratesService.getTransactionRate(currency, amountUSD, vaultId, 'withdrawal');
        const rampResponse: any = await this.partnaService.createRamp({
          type: 'cryptoToFiat',
          fromCurrency: 'USDC',
          fromNetwork: 'celo',
          toCurrency: currency,
          toNetwork: network,
          fromAmount: amountUSD,
          accountNumber: bankDetails.accountNumber,
          bankCode: bankDetails.bankCode,
          accountName: bankDetails.accountName,
          rateKey: rateKey,
          rampReference: rampReference,
          cancelPendingRampRequest: false,
        });

        const cryptoAddress = rampResponse?.data?.cryptoAddress;
        if (!cryptoAddress) throw new Error('No crypto address from Partna');

        const amountWei = ethers.parseUnits(amountUSD.toString(), vault.tokenDecimals);
        await this.blockchainService.transferTreasuryToken(cryptoAddress, amountWei, vault.tokenAddress);

        await this.prisma.vault.update({
          where: { id: vaultId },
          data: {
            status: VaultStatus.WITHDRAWAL_PENDING,
            partnaRampReference: rampReference,
            partnaRateKey: rateKey,
            partnaBankName: bankDetails.bankName,
            partnaBankCode: bankDetails.bankCode,
            partnaAccountNumber: bankDetails.accountNumber,
            partnaAccountName: bankDetails.accountName,
          },
        });

        return { success: true, provider: 'partna' };
      } catch (partnaError) {
        this.logger.error(`Withdrawal totally failed for vault ${vaultId}: ${partnaError.message}`);
        
        // If this was the last attempt, mark as failed
        if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
          this.logger.error(`[ADMIN ALERT] Withdrawal failed for vault ${vaultId} after max attempts`);
          await this.prisma.vault.update({
            where: { id: vaultId },
            data: { status: VaultStatus.WITHDRAWAL_FAILED },
          });
        }
        throw partnaError; // Re-throw to trigger BullMQ retry
      }
    }
  }
}
