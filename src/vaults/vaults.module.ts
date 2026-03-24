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
import { forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    LedgerModule,
    PrismaModule,
    InvitesModule,
    NotificationsModule,
    ServicesModule,
    BullModule.registerQueue({
      name: 'withdrawal-retry',
    }),
  ],
  controllers: [VaultsController],
  providers: [VaultsService, VaultsExpiryJob, WithdrawalRetryProcessor, PaycrestMonitoringJob],
  exports: [VaultsService],
})
export class VaultsModule {}
