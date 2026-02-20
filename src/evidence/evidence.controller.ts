import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { EvidenceService } from './evidence.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';
import { User } from '../common/decorators/user.decorator';
import { UserRole, EvidenceType } from '../domain/enums';

@Controller('evidence')
export class EvidenceController {
  constructor(private readonly evidenceService: EvidenceService) {}

  @Post()
  async create(@User('id') userId: string, @User('role') role: UserRole, @Body() dto: CreateEvidenceDto) {
    return this.evidenceService.create(userId, role, dto);
  }

  @Get()
  async list(
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Query('vaultId') vaultId: string,
    @Query('milestoneId') milestoneId?: string,
    @Query('type') type?: EvidenceType,
  ) {
    return this.evidenceService.list(userId, role, vaultId, milestoneId, type);
  }
}
