import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import { LedgerEntryType, TransactionStatus, KycStatus } from '../domain/enums';
import { WithdrawDto } from './dto/withdraw.dto';
import { PaymentRouter } from '../common/services/payment-router.service';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private paymentRouter: PaymentRouter,
    private configService: ConfigService,
  ) {}

  async getBalance(userId: string, role: string) {
    const prisma = this.prisma;
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: TransactionStatus.CONFIRMED,
      },
    });

    const available = entries.reduce((sum, entry) => sum + entry.amount, BigInt(0));

    const pendingEntries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: TransactionStatus.PENDING,
      },
    });

    const pending = pendingEntries.reduce(
      (sum, entry) => sum + entry.amount,
      BigInt(0),
    );

    return {
      available,
      pending,
      total: available + pending,
    };
  }

  async getTransactions(
    userId: string,
    role: string,
    limit: number = 50,
    offset: number = 0,
    type?: LedgerEntryType,
  ) {
    const prisma = this.prisma;
    const where: any = { userId };
    if (type) where.type = type;

    const [transactions, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        take: +limit,
        skip: +offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    return {
      transactions,
      total,
      limit: +limit,
      offset: +offset,
    };
  }

  async withdraw(userId: string, role: string, dto: WithdrawDto) {
    const prisma = this.prisma;
    // 1. Check KYC status
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.kycStatus !== KycStatus.VERIFIED) {
      throw new ForbiddenException({
        code: 'KYC_REQUIRED',
        message: 'KYC verification required for withdrawals',
      });
    }

    // 2. Check Idempotency
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });
    if (existing) return existing.responseBody;

    // 3. Check Balance
    const balance = await this.getBalance(userId, role);
    const withdrawAmountBigInt = ethers.parseUnits(dto.amount.toString(), 18); // Defaulting to 18 decimals for now
    
    if (balance.available < withdrawAmountBigInt) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Amount exceeds available balance',
      });
    }

    // 4. Create Withdrawal Record (LedgerEntry)
    const result = await prisma.$transaction(async (tx) => {
      const providerRef = `withdraw_${userId}_${Date.now()}`;

      const entry = await tx.ledgerEntry.create({
        data: {
          userId,
          type: LedgerEntryType.WITHDRAW,
          amount: -withdrawAmountBigInt, // Negative for withdrawal
          currency: dto.currency || 'USD',
          status: TransactionStatus.PENDING,
          description: `Withdrawal to bank account ***${dto.bankDetails.accountNumber.slice(-4)}`,
          providerRef,
        },
      });

      // Trigger Payment Router (Offramp)
      const user = await tx.user.findUnique({ where: { id: userId } });
      const offrampResult = await this.paymentRouter.initiateOfframp({
        amount: dto.amount,
        currency: dto.currency || 'USD',
        reference: providerRef,
        bankDetails: {
          account_number: dto.bankDetails.accountNumber,
          bank_code: dto.bankDetails.routingNumber,
          account_name: dto.bankDetails.accountName,
        },
        customerEmail: user?.email || '',
      });

      // Simple response body for current state
      const responseBody = {
        id: entry.id,
        createdAt: entry.createdAt,
        type: 'WITHDRAW',
        amount: entry.amount,
        currency: dto.currency || 'USD',
        status: entry.status,
        providerRef,
      };

      await tx.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey,
          userId,
          endpoint: '/api/ledger/withdraw',
          requestHash: 'N/A', // Should hash request in production
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
