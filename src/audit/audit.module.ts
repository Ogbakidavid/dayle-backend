import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ReconcilerService } from './reconciler.service';
import { PrismaModule } from '../prisma/prisma.module';
import { ServicesModule } from '../common/services/services.module';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, ServicesModule],
  providers: [ReconcilerService],
  exports: [ReconcilerService],
})
export class AuditModule {}
