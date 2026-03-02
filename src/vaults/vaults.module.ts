import { Module } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InvitesModule } from '../invites/invites.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [LedgerModule, PrismaModule, InvitesModule, NotificationsModule],
  controllers: [VaultsController],
  providers: [VaultsService],
})
export class VaultsModule {}
