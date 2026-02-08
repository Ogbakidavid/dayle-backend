import { Controller, Get, Post, Query, Body } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { User } from "../common/decorators/user.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { LedgerEntryType, UserRole } from "../domain/enums";
import { WithdrawDto } from "./dto/withdraw.dto";

@Controller("ledger")
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get("balance")
  async getBalance(@User("id") userId: string) {
    return this.ledgerService.getBalance(userId);
  }

  @Get("transactions")
  async getTransactions(
    @User("id") userId: string,
    @Query("limit") limit?: number,
    @Query("offset") offset?: number,
    @Query("type") type?: LedgerEntryType,
  ) {
    return this.ledgerService.getTransactions(userId, limit, offset, type);
  }

  @Post("withdraw")
  @Roles(UserRole.FREELANCER)
  async withdraw(@User("id") userId: string, @Body() dto: WithdrawDto) {
    return this.ledgerService.withdraw(userId, dto);
  }
}
