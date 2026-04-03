import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import { LedgerEntryType, TransactionStatus, KycStatus } from '../domain/enums';
import { WithdrawDto } from './dto/withdraw.dto';
import { PaymentRouter } from '../common/services/payment-router.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private paymentRouter: PaymentRouter,
    private notificationsService: NotificationsService,
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

    const isClient = role.toUpperCase() === 'CLIENT';

    const available = entries.reduce((sum, entry) => {
      if (
        isClient &&
        (entry.type === LedgerEntryType.DEPOSIT ||
          entry.type === LedgerEntryType.FEE)
      ) {
        return sum;
      }
      if (!isClient && entry.type === LedgerEntryType.LOCK) {
        return sum;
      }
      return sum + entry.amount;
    }, BigInt(0));

    const pendingEntries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.CONFIRMED] },
      },
    });

    const pending = pendingEntries.reduce((sum, entry) => {
      // For Clients, DEPOSIT (vault fund) shows as pending while the vault itself is AWAITING_PAYMENT
      // For Freelancers, LOCK entries are "Pending Settlement" until released.
      if (
        (isClient && entry.status === TransactionStatus.PENDING && (entry.type === LedgerEntryType.DEPOSIT || entry.type === LedgerEntryType.FEE)) ||
        (!isClient && entry.type === LedgerEntryType.LOCK)
      ) {
        return sum + (entry.amount < 0 ? -entry.amount : entry.amount);
      }
      // Traditional withdrawal pending logic
      if (entry.status === TransactionStatus.PENDING && (entry.type === LedgerEntryType.WITHDRAW || entry.type === LedgerEntryType.FEE)) {
         return sum + (entry.amount < 0 ? -entry.amount : entry.amount);
      }
      return sum;
    }, BigInt(0));

    return {
      available: available.toString(),
      pending: pending.toString(),
      total: (available + pending).toString(),
      formattedAvailable: ethers.formatUnits(available, 6), // Default to 6 decimals for USDC/USDT/CUSD
      formattedPending: ethers.formatUnits(pending, 6),
      formattedTotal: ethers.formatUnits(available + pending, 6),
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
    // Stablecoins (cUSD, USDC, USDT) use 6 decimals; this must be consistent with
    // getBalance() which also formats to 6 decimals. Do NOT use 18 here.
    const DECIMALS = 6;
    const withdrawAmountBigInt = ethers.parseUnits(
      dto.amount.toString(),
      DECIMALS,
    );

    if (BigInt(balance.available) < withdrawAmountBigInt) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Amount exceeds available balance',
      });
    }

    // 4. Create Withdrawal Record (LedgerEntry)
    const result = await prisma.$transaction(async (tx) => {
      const providerRef = `withdraw_${userId}_${Date.now()}`;

      // Fee calculation
      const PROVIDER_FEE_PERCENT = 0.01; // 1.0% (Partna)
      const APP_FEE_PERCENT = 0.005; // 0.5% (Dayle)

      const providerFee = dto.amount * PROVIDER_FEE_PERCENT;
      const appFee = dto.amount * APP_FEE_PERCENT;
      const totalFees = providerFee + appFee;
      const netAmount = dto.amount - totalFees;

      // BigInt conversions for ledger — use same DECIMALS for consistency
      const appFeeBigInt = ethers.parseUnits(
        appFee.toFixed(DECIMALS),
        DECIMALS,
      );
      const netAmountBigInt = ethers.parseUnits(
        netAmount.toFixed(DECIMALS),
        DECIMALS,
      );

      // 4a. Create gross withdrawal entry
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

      // 4b. Create platform fee entry
      await tx.ledgerEntry.create({
        data: {
          userId,
          type: LedgerEntryType.FEE,
          amount: -appFeeBigInt, // Deduction for the app fee
          currency: dto.currency || 'USD',
          status: TransactionStatus.CONFIRMED, // Fees are confirmed immediately on initiation
          description: `Service fee for withdrawal ${entry.id}`,
          completedAt: new Date(),
        },
      });

      // Trigger Payment Router (Offramp) with NET amount
      const user = await tx.user.findUnique({ where: { id: userId } });
      const offrampResult = await this.paymentRouter.initiateOfframp({
        amount: netAmount, // Send ONLY the net amount
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
        netAmount: netAmount.toString(),
        totalFees: totalFees.toString(),
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

      // Notify user about withdrawal initiation
      await this.notificationsService.createNotification(userId, {
        type: 'payment',
        title: 'Withdrawal Initiated',
        message: `Your withdrawal of ${dto.amount} ${dto.currency || 'USD'} has been initiated.`,
        action: '/settings',
      });

      return responseBody;
    });

    return result;
  }
}
