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
          BullModule.registerQueue({
            name: 'withdrawal-retry',
            defaultJobOptions: {
              removeOnComplete: 100,
              removeOnFail: 50,
              attempts: 3,
              backoff: {
                type: 'exponential',
                delay: 5000,
              },
            },
          }),
        ]
      : []),
  ],
  controllers: [VaultsController],
  providers: [
    VaultsService,
    VaultsExpiryJob,
    PaycrestMonitoringJob,
    ...(process.env.ENABLE_BULL !== 'false' ? [WithdrawalRetryProcessor] : []),
  ],
  exports: [VaultsService],
})
export class VaultsModule {}
