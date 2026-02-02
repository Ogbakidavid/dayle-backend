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
import { WalletModule } from "./wallet/wallet.module";
import { LedgerModule } from "./ledger/ledger.module";
import { DisputesModule } from "./disputes/disputes.module";
import { UploadsModule } from "./uploads/uploads.module";
import { VerificationModule } from "./verification/verification.module";
import { AuthGuard } from "./common/guards/auth.guard";
import { RolesGuard } from "./common/guards/roles.guard";


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true}),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: "24h" },
      }),
    }),
    PrismaModule,
    AuthModule,
    OnboardingModule,
    VaultsModule,
    MilestonesModule,
    InvitesModule,
    WalletModule,
    LedgerModule,
    DisputesModule,
    UploadsModule,
    VerificationModule,
    

  ],
  providers: [
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