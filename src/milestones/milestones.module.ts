import { Module } from '@nestjs/common';
import { MilestonesService } from './milestones.service';
import { MilestonesController } from './milestones.controller';
import { VerificationModule } from '../verification/verification.module';
import { EvidenceModule } from '../evidence/evidence.module';

@Module({
  imports: [VerificationModule, EvidenceModule],
  controllers: [MilestonesController],
  providers: [MilestonesService],
})
export class MilestonesModule {}
