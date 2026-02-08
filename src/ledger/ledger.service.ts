import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerEntryType, TransactionStatus, KycStatus } from "../domain/enums";
import { WithdrawDto } from "./dto/withdraw.dto";

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async getBalance(userId: string) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: TransactionStatus.CONFIRMED,
      },
    });

    const available = entries.reduce((sum, entry) => sum + entry.amount, 0);

    const pendingEntries = await this.prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: TransactionStatus.PENDING,
      },
    });

    const pending = pendingEntries.reduce((sum, entry) => sum + entry.amount, 0);

    return {
      available,
      pending,
      total: available + pending,
    };
  }

  async getTransactions(
    userId: string,
    limit: number = 50,
    offset: number = 0,
    type?: LedgerEntryType,
  ) {
    const where: any = { userId };
    if (type) where.type = type;

    const [transactions, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        take: +limit,
        skip: +offset,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);

    return {
      transactions,
      total,
      limit: +limit,
      offset: +offset,
    };
  }

  async withdraw(userId: string, dto: WithdrawDto) {
    // 1. Check KYC status
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException({
        code: "KYC_REQUIRED",
        message: "KYC verification required for withdrawals",
      });
    }

    // 2. Check Idempotency
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });
    if (existing) return existing.responseBody;

    // 3. Check Balance
    const balance = await this.getBalance(userId);
    if (balance.available < dto.amount) {
      throw new BadRequestException({
        code: "INSUFFICIENT_FUNDS",
        message: "Amount exceeds available balance",
      });
    }

    // 4. Create Withdrawal Record (LedgerEntry)
    const result = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.ledgerEntry.create({
        data: {
          userId,
          type: LedgerEntryType.WITHDRAW,
          amount: -dto.amount, // Negative for withdrawal
          currency: "USD",
          status: TransactionStatus.PENDING,
          description: `Withdrawal to bank account ***${dto.bankDetails.accountNumber.slice(-4)}`,
        },
      });

      // Simple response body for current state
      const responseBody = {
        id: entry.id,
        createdAt: entry.createdAt,
        type: "WITHDRAW",
        amount: entry.amount,
        currency: "USD",
        status: entry.status,
      };

      await tx.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey,
          userId,
          endpoint: "/api/ledger/withdraw",
          requestHash: "N/A", // Should hash request in production
          responseBody: responseBody as any,
          statusCode: 201,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return responseBody;
    });

    return result;
  }
}
