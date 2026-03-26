import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { MailsService } from './mails.service';
import { MailProcessor } from './mail.processor';

import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NotificationsGateway } from './notifications.gateway';

@Module({
  imports: [
    ...(process.env.ENABLE_BULL !== 'false'
      ? [
          BullModule.registerQueue({
            name: 'mail',
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
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MailsService,
    NotificationsGateway,
    ...(process.env.ENABLE_BULL !== 'false' ? [MailProcessor] : []),
  ],
  exports: [MailsService, NotificationsGateway, NotificationsService],
})
export class NotificationsModule {}
