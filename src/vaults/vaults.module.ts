import { Module } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { VaultsController } from './vaults.controller';

@Module({
  controllers: [VaultsController],
  providers: [VaultsService],
})
export class VaultsModule {}
