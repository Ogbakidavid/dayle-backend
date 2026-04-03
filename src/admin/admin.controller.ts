import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  Delete,
  Post,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminService } from './admin.service';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole, DisputeStatus } from '../domain/enums';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@Controller('admin')
@UseGuards(AuthGuard('admin-jwt'))
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getStats(@Req() req: any) {
    return this.adminService.getStats(req.user);
  }

  @Get('users')
  async getUsers(@Req() req: any) {
    return this.adminService.getUsers(req.user);
  }

  @Get('vaults')
  async getVaults(@Req() req: any) {
    return this.adminService.getVaults(req.user);
  }

  @Get('disputes')
  async getDisputes(@Req() req: any) {
    return this.adminService.getDisputes(req.user);
  }

  @Patch('kyc/:userId/approve')
  async approveKyc(@Req() req: any, @Param('userId') userId: string) {
    return this.adminService.handleKyc(req.user, userId, 'VERIFIED');
  }

  @Patch('kyc/:userId/reject')
  async rejectKyc(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body('reason') reason: string,
  ) {
    return this.adminService.handleKyc(req.user, userId, 'REJECTED', reason);
  }

  @Patch('kyc/:userId/reset')
  async resetKyc(@Req() req: any, @Param('userId') userId: string) {
    return this.adminService.resetKyc(req.user, userId);
  }

  @Post('users/:id/verify')
  async manualVerifyUser(@Param('id') id: string, @Req() req: any) {
    return this.adminService.manualVerifyUser(id, req.user.id);
  }

  @Get('ledger')
  async getLedger(@Req() req: any) {
    return this.adminService.getLedger(req.user);
  }

  @Get('logs')
  async getSystemLogs(@Req() req: any, @Query('limit') limit?: number) {
    return this.adminService.getSystemLogs(
      req.user,
      limit ? Number(limit) : 10,
    );
  }

  @Get('webhooks/didit/logs')
  async getDiditWebhookLogs(@Req() req: any) {
    return this.adminService.getDiditWebhookLogs(req.user);
  }

  @Patch('disputes/:id/resolve')
  async resolveDispute(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.adminService.resolveDispute(
      req.user.id,
      req.user.role,
      id,
      dto,
    );
  }

  @Delete('sessions/:userId')
  async revokeUserSessions(@Req() req: any, @Param('userId') userId: string) {
    return this.adminService.revokeUserSessions(req.user.id, userId);
  }

  @Get('withdrawals')
  async getWithdrawals(@Req() req: any) {
    return this.adminService.getWithdrawals(req.user);
  }

  @Get('revenue')
  async getRevenue(@Req() req: any) {
    return this.adminService.getRevenue(req.user);
  }

  @Post('withdrawals/:id/retry')
  async retryWithdrawal(@Req() req: any, @Param('id') id: string) {
    return this.adminService.retryWithdrawal(req.user.id, id);
  }

  @Patch('withdrawals/:id/fail')
  async markWithdrawalFailed(@Req() req: any, @Param('id') id: string) {
    return this.adminService.markWithdrawalFailed(req.user.id, id);
  }
}
