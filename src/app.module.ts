import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
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
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
      useFactory: (configService: ConfigService) => ({
        throttlers: [{ ttl: 60000, limit: 100 }],
        storage: new ThrottlerStorageRedisService(
          configService.get<string>('REDIS_URL'),
        ),
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
          maxRetriesPerRequest: null,
        },
      }),
    }),
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
