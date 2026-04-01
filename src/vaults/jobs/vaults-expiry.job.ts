import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { VaultStatus } from '../../domain/enums';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class VaultsExpiryJob {
  private readonly logger = new Logger(VaultsExpiryJob.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleVaultExpirations() {
    this.logger.log('Running Vault Expiry Job...');
    const now = new Date();

    try {
      // Find vaults that are AWAITING_PAYMENT and have passed their expiry date
      const expiredVaults = await this.prisma.vault.findMany({
        where: {
          status: VaultStatus.AWAITING_PAYMENT,
          partnaExpiryDate: {
            lt: now,
          },
        },
      });

      if (expiredVaults.length === 0) {
        return;
      }

      this.logger.log(`Found ${expiredVaults.length} expired vaults. Reverting to DRAFT...`);

      for (const vault of expiredVaults) {
        try {
          await this.prisma.vault.update({
            where: { id: vault.id },
            data: {
              status: VaultStatus.DRAFT,
              partnaAccountNumber: null,
              partnaBankName: null,
              partnaAccountName: null,
              partnaRampReference: null,
              partnaFromAmount: null,
              partnaFromCurrency: null,
              partnaExpectedAmount: null,
              partnaExpiryDate: null,
            },
          });

          await this.notificationsService.createNotification(vault.clientId, {
            type: 'payment',
            title: 'Payment Window Expired',
            message: `Your payment window for vault "${vault.title}" has expired. You can initiate funding again if you still wish to proceed.`,
            action: `/client/vault/${vault.id}`,
          });

          this.logger.log(`Vault ${vault.id} reverted to DRAFT due to expiry.`);
        } catch (error) {
          this.logger.error(`Failed to revert vault ${vault.id} to DRAFT: ${error.message}`);
        }
      }
    } catch (err) {
      if (err.message.includes('EAI_AGAIN') || err.message.includes('P1001')) {
        this.logger.warn('Vault Expiry Job: Database temporarily unreachable. Skipping this run.');
      } else {
        this.logger.error(`Vault Expiry Job Failed: ${err.message}`);
      }
    }
  }
}
