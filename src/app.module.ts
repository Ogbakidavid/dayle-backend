import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { VaultsModule } from "./vaults/vaults.module";
import { MilestonesModule } from "./milestones/milestones.module";
import { InvitesModule } from "./invites/invites.module";
import { LedgerModule } from "./ledger/ledger.module";
import { DisputesModule } from "./disputes/disputes.module";
import { UploadsModule } from "./uploads/uploads.module";
import { EvidenceModule } from "./evidence/evidence.module";
import { VerificationModule } from "./verification/verification.module";
import { AdminModule } from "./admin/admin.module";
import { AdminAuthModule } from "./admin/auth/admin-auth.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthGuard } from "./common/guards/auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";
import { NotificationsModule } from './notifications/notifications.module';
import { RedisModule } from "./common/redis/redis.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { ServicesModule } from "./common/services/services.module";
import { AuditModule } from "./audit/audit.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: "24h" },
      }),
    }),
    PrismaModule,
    RedisModule,
    ServicesModule,
    AuthModule,
    OnboardingModule,
    VaultsModule,
    MilestonesModule,
    InvitesModule,
    LedgerModule,
    DisputesModule,
    UploadsModule,
    EvidenceModule,
    VerificationModule,
    AdminModule,
    NotificationsModule,
    WebhooksModule,
    NotificationsModule,
    WebhooksModule,
    AuditModule,
    AdminAuthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}