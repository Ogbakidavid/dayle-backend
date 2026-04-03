import 'dotenv/config';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { VaultsModule } from './vaults/vaults.module';
import { InvitesModule } from './invites/invites.module';
import { LedgerModule } from './ledger/ledger.module';
import { DisputesModule } from './disputes/disputes.module';
import { UploadsModule } from './uploads/uploads.module';
import { EvidenceModule } from './evidence/evidence.module';
import { AdminModule } from './admin/admin.module';
import { AdminAuthModule } from './admin/auth/admin-auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { NotificationsModule } from './notifications/notifications.module';
import { RedisModule } from './common/redis/redis.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ServicesModule } from './common/services/services.module';
import { AuditModule } from './audit/audit.module';
import { RlsInterceptor } from './common/interceptors/rls.interceptor';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { RatesModule } from './rates/rates.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '24h' },
      }),
    }),
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const throttlerOptions: any = {
          throttlers: [
            // Default global limit: 1000 requests per minute
            { name: 'default', ttl: 60000, limit: 1000 },
            // Payment endpoints: max 100 requests per minute
            { name: 'payment', ttl: 60000, limit: 100 },
            // Auth endpoints: max 100 requests per minute
            { name: 'auth', ttl: 60000, limit: 100 },
            // Rate endpoints: max 2000 requests per minute
            { name: 'rates', ttl: 60000, limit: 2000 },
          ],
        };

        if (configService.get('ENABLE_REDIS') !== 'false') {
          const redisUrl = configService.get<string>('REDIS_URL');
          if (redisUrl) {
            throttlerOptions.storage = new ThrottlerStorageRedisService(
              new Redis(redisUrl, {
                tls: redisUrl.startsWith('rediss://') ? {} : undefined,
              }),
            );
          }
        }

        return throttlerOptions;
      },
    }),
    ...(process.env.ENABLE_BULL !== 'false'
      ? [
          BullModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
              const redisUrl = configService.get<string>('REDIS_URL');
              return {
                connection: {
                  url: redisUrl,
                  maxRetriesPerRequest: null,
                  tls: redisUrl?.startsWith('rediss://') ? {} : undefined,
                },
                // Global worker settings to reduce Redis command volume (~90% savings)
                defaultJobOptions: {
                  removeOnComplete: 20,
                  removeOnFail: 20,
                  attempts: 3,
                  backoff: {
                    type: 'exponential',
                    delay: 5000,
                  },
                  ...(process.env.TESTNET_MODE === 'true'
                    ? { skipStalledCheck: true, delay: 0 }
                    : {}),
                },
                // Optimized worker defaults
                workerOptions: {
                  concurrency: 1,
                  stalledInterval: 300000,
                  lockDuration: 300000,
                  drainDelay: 300000,
                },
              };
            },
          }),
        ]
      : []),
    ServicesModule,
    AuthModule,
    OnboardingModule,
    VaultsModule,
    InvitesModule,
    LedgerModule,
    DisputesModule,
    UploadsModule,
    EvidenceModule,
    AdminModule,
    NotificationsModule,
    WebhooksModule,
    AuditModule,
    AdminAuthModule,
    PaymentMethodsModule,
    RatesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsInterceptor,
    },
  ],
})
export class AppModule {}
