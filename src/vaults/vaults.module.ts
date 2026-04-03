import { Module } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InvitesModule } from '../invites/invites.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ServicesModule } from '../common/services/services.module';
import { VaultsExpiryJob } from './jobs/vaults-expiry.job';
import { BullModule } from '@nestjs/bullmq';
import { WithdrawalRetryProcessor } from './withdrawal-retry.processor';
import { VaultWithdrawalProcessor } from './vault-withdrawal.processor';
import { VaultReleaseProcessor } from './vault-release.processor';
import { VaultRefundProcessor } from './vault-refund.processor';
import { PaycrestMonitoringJob } from './jobs/paycrest-monitoring.job';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    LedgerModule,
    PrismaModule,
    InvitesModule,
    NotificationsModule,
    ServicesModule,
    ...(process.env.ENABLE_BULL !== 'false'
      ? [
          BullModule.registerQueue(
            {
              name: 'vault-withdrawal',
              defaultJobOptions: {
                removeOnComplete: 20,
                removeOnFail: 20,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            },
            {
              name: 'vault-release',
              defaultJobOptions: {
                removeOnComplete: 20,
                removeOnFail: 20,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            },
            {
              name: 'vault-refund',
              defaultJobOptions: {
                removeOnComplete: 20,
                removeOnFail: 20,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            },
          ),
        ]
      : []),
  ],
  controllers: [VaultsController],
  providers: [
    VaultsService,
    // Only run monitoring jobs in production (not testnet)
    ...(process.env.TESTNET_MODE !== 'true' &&
    process.env.NODE_ENV === 'production'
      ? [VaultsExpiryJob, PaycrestMonitoringJob]
      : []),
    ...(process.env.ENABLE_BULL !== 'false'
      ? [
          WithdrawalRetryProcessor,
          VaultWithdrawalProcessor,
          VaultReleaseProcessor,
          VaultRefundProcessor,
        ]
      : []),
  ],
  exports: [VaultsService],
})
export class VaultsModule {}
