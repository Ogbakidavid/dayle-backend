import { Module } from "@nestjs/common";
import { EvidenceService } from "./evidence.service";
import { EvidenceController } from "./evidence.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
  imports: [PrismaModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
