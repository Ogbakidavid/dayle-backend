import { Module } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { DisputesController } from './disputes.controller';
import { DisputeAiService } from './dispute-ai.service';

@Module({
  controllers: [DisputesController],
  providers: [DisputesService, DisputeAiService],
  exports: [DisputesService, DisputeAiService],
})
export class DisputesModule {}
