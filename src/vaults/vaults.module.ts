import { Module } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [LedgerModule, PrismaModule],
  controllers: [VaultsController],
  providers: [VaultsService],
})
export class VaultsModule {}
