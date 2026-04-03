import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { PrismaService } from '../prisma/prisma.service';
import { VaultStatus } from '../domain/enums';

@Processor('withdrawal-retry')
export class WithdrawalRetryProcessor extends WorkerHost {
  private readonly logger = new Logger(WithdrawalRetryProcessor.name);

  constructor(
    private readonly vaultsService: VaultsService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { vaultId, userId, bankDetails, retryCount } = job.data;
    this.logger.log(
      `Processing withdrawal retry for vault ${vaultId}, attempt ${retryCount + 1}`,
    );

    try {
      const vault = await this.prisma.vault.findUnique({
        where: { id: vaultId },
      });

      if (!vault || vault.status !== VaultStatus.WITHDRAWAL_PENDING) {
        this.logger.warn(
          `Vault ${vaultId} not in WITHDRAWAL_PENDING state. Skipping retry.`,
        );
        return;
      }

      await this.vaultsService.initiateWithdrawal(
        vaultId,
        userId,
        bankDetails,
        retryCount,
      );
      this.logger.log(`Withdrawal retry successful for vault ${vaultId}`);
    } catch (error) {
      this.logger.error(
        `Withdrawal retry failed for vault ${vaultId}: ${error.message}`,
      );
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }
}
