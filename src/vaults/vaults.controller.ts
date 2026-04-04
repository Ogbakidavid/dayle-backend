import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Patch,
  Query,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { Response } from 'express';
import { VaultsService } from './vaults.service';
import { CreateVaultDto } from './dto/create-vault.dto';
import { ReleaseVaultDto } from './dto/release-vault.dto';
import { RefundVaultDto } from './dto/refund-vault.dto';
import { FundVaultDto } from './dto/fund-vault.dto';
import { UpdateVaultStatusDto } from './dto/update-vault-status.dto';
import { SubmitVaultDto } from './dto/submit-vault.dto';
import { RequestRefundDto } from './dto/request-refund.dto';
import { WithdrawVaultDto } from './dto/withdraw-vault.dto';
import { UpdateFreelancerDto } from './dto/update-freelancer.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { User } from '../common/decorators/user.decorator';
import { UserRole } from '../domain/enums';
import { ConfigService } from '@nestjs/config';

@Controller('vaults')
export class VaultsController {
  constructor(private vaultsService: VaultsService, private configService: ConfigService) {}

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

  @Get(':id/status')
  async getStatus(@Param('id') id: string) {
    const vault = await this.vaultsService.getStatus(id);
    return { status: vault.status };
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
    if (dto.currency === 'NGN' || dto.currency === 'KES') {
      return this.vaultsService.initiatePartnaFunding(id, userId, dto);
    }
    return this.vaultsService.fund(id, dto, userId, role);
  }

  @Post(':id/mock-deposit')
  @Roles(UserRole.CLIENT)
  async mockDeposit(
    @Param('id') id: string,
    @Body() body: { amount?: number; accountName?: string },
  ) {
    if (
      this.configService.get('NODE_ENV') === 'production' &&
      this.configService.get('TESTNET_MODE') !== 'true'
    ) {
      throw new ForbiddenException(
        'Mock deposit is only available in development or testnet mode',
      );
    }
    return this.vaultsService.mockPartnaDeposit(
      id,
      body.amount,
      body.accountName,
    );
  }

  @Post(':id/confirm-payment')
  @Roles(UserRole.CLIENT)
  async confirmPayment(@Param('id') id: string, @User('id') userId: string) {
    return this.vaultsService.confirmPayment(id, userId);
  }

  @Post(':id/withdraw')
  @Roles(UserRole.FREELANCER)
  async withdraw(
    @Param('id') id: string,
    @Body()
    bankDetails: {
      accountNumber: string;
      bankCode: string;
      accountName: string;
    },
    @User('id') userId: string,
  ) {
    return this.vaultsService.initiateWithdrawal(id, userId, bankDetails);
  }

  @Get(':id/payment-callback')
  async handlePartnaCallback(
    @Param('id') id: string,
    @Query('vouchercode') vouchercode: string,
    @Query('voucherId') voucherId: string,
    @Res() res: any,
  ) {
    await this.vaultsService.handlePartnaCallback(id, vouchercode, voucherId);
    const frontendUrl = process.env.FRONTEND_URL || 'https://dayle.netlify.app';
    return res.redirect(`${frontendUrl}/client/vault/${id}?status=processing`);
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

  @Post(':id/request-release')
  @Roles(UserRole.FREELANCER)
  async requestRelease(@Param('id') id: string, @User('id') userId: string) {
    return this.vaultsService.requestRelease(id, userId);
  }
}
