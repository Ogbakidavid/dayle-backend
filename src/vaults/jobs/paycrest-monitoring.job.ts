import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { VaultStatus } from '../../domain/enums';

@Injectable()
export class PaycrestMonitoringJob {
  private readonly logger = new Logger(PaycrestMonitoringJob.name);

  constructor(private prisma: PrismaService) {}

  @Cron('*/2 * * * *')
  async monitorPaycrestTransfers() {
    this.logger.log('Running Paycrest Monitoring Job...');
    
    const now = new Date();
    const alertThreshold = new Date(now.getTime() - 4 * 60 * 1000); // 4 minutes ago

    try {
      // Find WITHDRAWAL_PENDING Kenyan vaults where USDC might not have been sent correctly
      // or the order is about to expire.
      const pendingVaults = await this.prisma.vault.findMany({
        where: {
          status: VaultStatus.WITHDRAWAL_PENDING,
          paycrestOrderId: { not: null },
        },
        include: { freelancer: true },
      });

      for (const vault of pendingVaults) {
        // 1. Alert if USDC hasn't been sent within 4 minutes of order creation
        if (vault.paycrestOrderCreatedAt && vault.paycrestOrderCreatedAt < alertThreshold) {
          this.logger.error(`[ADMIN ALERT] Paycrest order ${vault.paycrestOrderId} for Vault ${vault.id} has not been released. Arbiter check required.`);
        }

        // 2. Alert if validUntil is approaching
        if (vault.paycrestValidUntil) {
          const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
          if (vault.paycrestValidUntil < fiveMinutesFromNow) {
            this.logger.warn(`[ADMIN ALERT] Paycrest order ${vault.paycrestOrderId} for Vault ${vault.id} is approaching expiration.`);
          }
        }
      }
    } catch (err) {
      if (err.message.includes('EAI_AGAIN') || err.message.includes('P1001')) {
        this.logger.warn('Paycrest Monitoring Job: Database temporarily unreachable. Skipping this run.');
      } else {
        this.logger.error(`Paycrest Monitoring Job Failed: ${err.message}`);
      }
    }
  }
}
