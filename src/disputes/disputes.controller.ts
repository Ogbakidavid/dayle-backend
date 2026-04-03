import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { DisputeAiService } from './dispute-ai.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { User } from '../common/decorators/user.decorator';
import { DisputeStatus, UserRole } from '../domain/enums';

@Controller('disputes')
export class DisputesController {
  constructor(
    private readonly disputesService: DisputesService,
    private readonly disputeAiService: DisputeAiService,
  ) {}

  @Post(':id/analyze')
  async analyze(@Param('id') id: string, @User('role') role: UserRole) {
    if (role !== UserRole.ADMIN) {
      throw new Error('Not authorized');
    }
    return this.disputeAiService.analyzeDispute(id);
  }

  @Post()
  async create(
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Body() dto: CreateDisputeDto,
  ) {
    return this.disputesService.create(userId, role, dto);
  }

  @Get()
  async list(
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Query('status') status?: DisputeStatus,
    @Query('vaultId') vaultId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.disputesService.list(
      userId,
      role,
      status,
      vaultId,
      limit,
      offset,
    );
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.disputesService.getById(id, userId, role);
  }

  @Get('vault/:vaultId')
  async listForVault(
    @Param('vaultId') vaultId: string,
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Query('status') status?: DisputeStatus,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.disputesService.list(
      userId,
      role,
      status,
      vaultId,
      limit,
      offset,
    );
  }

  @Post(':id/resolve')
  async resolve(
    @Param('id') id: string,
    @User('id') adminId: string,
    @User('role') role: UserRole,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(id, adminId, role, dto);
  }

  @Post(':id/investigate')
  async investigate(
    @Param('id') id: string,
    @User('id') adminId: string,
    @User('role') role: UserRole,
  ) {
    if (role !== UserRole.ADMIN) {
      throw new ForbiddenException('Not authorized');
    }
    return this.disputesService.investigate(id, adminId);
  }

  @Post(':id/propose-settlement')
  async proposeSettlement(
    @Param('id') id: string,
    @User('id') userId: string,
    @Body() dto: { amountToFreelancer: number; notes: string },
  ) {
    return this.disputesService.proposeSettlement(id, userId, dto);
  }

  @Post(':id/accept-settlement')
  async acceptSettlement(@Param('id') id: string, @User('id') userId: string) {
    return this.disputesService.acceptSettlement(id, userId);
  }

  @Post(':id/request-total-refund')
  async requestTotalRefund(
    @Param('id') id: string,
    @User('id') userId: string,
    @Body() dto: { notes: string },
  ) {
    return this.disputesService.requestTotalRefund(id, userId, dto.notes);
  }

  @Post(':id/request-total-release')
  async requestTotalRelease(
    @Param('id') id: string,
    @User('id') userId: string,
    @Body() dto: { notes: string },
  ) {
    return this.disputesService.requestTotalRelease(id, userId, dto.notes);
  }
}
