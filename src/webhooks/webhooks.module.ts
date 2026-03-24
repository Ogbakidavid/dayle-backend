import { forwardRef, Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { InvitesModule } from '../invites/invites.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VaultsModule } from '../vaults/vaults.module';

@Module({
  imports: [InvitesModule, NotificationsModule, forwardRef(() => VaultsModule)],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
