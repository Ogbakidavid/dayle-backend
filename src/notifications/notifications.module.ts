import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { MailsService } from './mails.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, MailsService],
  exports: [MailsService],
})
export class NotificationsModule {}
