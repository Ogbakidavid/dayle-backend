import { Module } from '@nestjs/common';
import { MilestonesService } from './milestones.service';
import { MilestonesController } from './milestones.controller';

@Module({
  controllers: [MilestonesController],
  providers: [MilestonesService],
})
export class MilestonesModule {}
