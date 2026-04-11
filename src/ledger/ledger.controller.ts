import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { LedgerService } from './ledger.service';
import { User } from '../common/decorators/user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LedgerEntryType, UserRole } from '../domain/enums';
import { WithdrawDto } from './dto/withdraw.dto';

@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('balance')
  async getBalance(@User('id') userId: string, @User('role') role: UserRole) {
    return this.ledgerService.getBalance(userId, role);
  }

  @Get('transactions')
  async getTransactions(
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('type') type?: LedgerEntryType,
  ) {
    return this.ledgerService.getTransactions(
      userId,
      role,
      limit,
      offset,
      type,
    );
  }

  @Post('withdraw')
  @Roles(UserRole.FREELANCER)
  @Throttle({ payment: { ttl: 60000, limit: 10 } })
  async withdraw(
    @User('id') userId: string,
    @User('role') role: UserRole,
    @Body() dto: WithdrawDto,
  ) {
    return this.ledgerService.withdraw(userId, role, dto);
  }

  @Get('withdraw-preview')
  async withdrawPreview(
    @User('id') userId: string,
    @Query('amount') amount: number,
    @Query('currency') currency: string,
  ) {
    return this.ledgerService.getWithdrawalPreview(userId, amount, currency);
  }
}
