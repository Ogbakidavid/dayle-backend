import { Controller, Post, Get, Param, Body, Patch } from '@nestjs/common';
import { VaultsService } from './vaults.service';
import { CreateVaultDto } from './dto/create-vault.dto';
import { ReleaseVaultDto } from './dto/release-vault.dto';
import { RefundVaultDto } from './dto/refund-vault.dto';
import { FundVaultDto } from './dto/fund-vault.dto';
import { UpdateVaultStatusDto } from './dto/update-vault-status.dto';
import { SubmitVaultDto } from './dto/submit-vault.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { UpdateFreelancerDto } from './dto/update-freelancer.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { User } from '../common/decorators/user.decorator';
import { UserRole } from '../domain/enums';

@Controller('vaults')
export class VaultsController {
  constructor(private vaultsService: VaultsService) {}

  @Post()
  @Roles(UserRole.CLIENT)
  async create(
    @Body() dto: CreateVaultDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.create(dto, userId, role);
  }

  @Get()
  async list(@User('id') userId: string, @User('role') role: UserRole) {
    console.log(
      `[VaultsController] list request received. User=${userId}, Role=${role}`,
    );
    return this.vaultsService.list(userId, role);
  }

  @Get(':id')
  async getById(
    @Param('id') id: string,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.getById(id, userId, role);
  }

  @Post(':id/submit')
  @Roles(UserRole.FREELANCER)
  async submit(
    @Param('id') vaultId: string,
    @Body() dto: SubmitVaultDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.submit(vaultId, dto, userId, role);
  }

  @Post(':id/fund')
  @Roles(UserRole.CLIENT)
  async fund(
    @Param('id') id: string,
    @Body() dto: FundVaultDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.fund(id, dto, userId, role);
  }

  @Post(':id/release')
  @Roles(UserRole.CLIENT)
  async release(
    @Param('id') vaultId: string,
    @Body() dto: ReleaseVaultDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.release(vaultId, dto, userId, role);
  }

  @Post(':id/refund')
  @Roles(UserRole.CLIENT)
  async refund(
    @Param('id') vaultId: string,
    @Body() dto: RefundVaultDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.refund(vaultId, dto, userId, role);
  }

  @Patch(':id/status')
  @Roles(UserRole.CLIENT)
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateVaultStatusDto,
    @User('id') userId: string,
    @User('role') role: UserRole,
  ) {
    return this.vaultsService.updateStatus(id, dto, userId, role);
  }

  @Post(':id/request-refund')
  @Roles(UserRole.CLIENT)
  async requestRefund(
    @Param('id') id: string,
    @Body() dto: RequestRefundDto,
    @User('id') userId: string,
  ) {
    return this.vaultsService.requestRefund(id, userId, dto);
  }

  @Patch(':id/update-freelancer')
  @Roles(UserRole.CLIENT)
  async updateFreelancer(
    @Param('id') id: string,
    @Body() dto: UpdateFreelancerDto,
    @User('id') userId: string,
  ) {
    return this.vaultsService.updateFreelancer(id, userId, dto);
  }
}
