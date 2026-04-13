import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

import { LedgerEntryType, TransactionStatus, KycStatus, VaultStatus } from '../domain/enums';
import { WithdrawDto } from './dto/withdraw.dto';
import { PaymentRouter } from '../common/services/payment-router.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { RatesService } from '../rates/rates.service';
import { ethers } from 'ethers';

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private paymentRouter: PaymentRouter,
    private notificationsService: NotificationsService,
    private configService: ConfigService,
    private ratesService: RatesService,
  ) {}

  async getBalance(userId: string, role: string) {
    const prisma = this.prisma;
    const entries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: { in: [TransactionStatus.CONFIRMED, TransactionStatus.PENDING] },
      },
    });

    const isClient = role.toUpperCase() === 'CLIENT';

    const available = entries.reduce((sum, entry) => {
      // Logic for Clients (Money in/out of their account)
      if (isClient) {
        // REFUND adds to balance (as a positive number in DB)
        if (entry.type === LedgerEntryType.REFUND) return sum + entry.amount;
        
        // WITHDRAW / FEE / DEPOSIT (Funding) subtract from balance if negative,
        // but currently funding/deposits are recorded as positive when sent TO the system.
        // We need to ensure we only sum what's actually entering/leaving the account.
        if (entry.type === LedgerEntryType.WITHDRAW || entry.type === LedgerEntryType.FEE) {
          return sum + entry.amount; // Withdraw/Fee are stored as negative
        }
        
        // For clients, DEPOSIT (vault funding) counts as money ALREADY spent/locked.
        // It should NOT be part of 'available' for new spending.
        return sum;
      } 
      
      // Logic for Freelancers (Earnings)
      else {
        // Only RELEASE entries (from completed vaults or settled disputes) count as available earnings.
        if (entry.type === LedgerEntryType.RELEASE) return sum + entry.amount;
        
        // Withdrawals and Fees subtract from available
        if (entry.type === LedgerEntryType.WITHDRAW || entry.type === LedgerEntryType.FEE) {
          return sum + entry.amount; // Negative amount
        }
        
        // Other types (LOCK, DEPOSIT) are ignored for available balance
        return sum;
      }
    }, BigInt(0));

    const pendingEntries = await prisma.ledgerEntry.findMany({
      where: {
        userId,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.CONFIRMED] },
      },
      include: { vault: true },
    });

    const pending = pendingEntries.reduce((sum, entry) => {
      // For Clients, DEPOSIT (vault fund) shows as pending while the vault itself is AWAITING_PAYMENT
      // For Freelancers, LOCK entries are "Pending Settlement" until released.
      if (
        (isClient && entry.status === TransactionStatus.PENDING && (entry.type === LedgerEntryType.DEPOSIT || entry.type === LedgerEntryType.FEE)) ||
        (!isClient && entry.type === LedgerEntryType.LOCK && entry.vault?.status === (VaultStatus.RELEASE_REQUESTED as any))
      ) {
        return sum + (entry.amount < 0 ? -entry.amount : entry.amount);
      }
      // Traditional withdrawal pending logic
      if (entry.status === TransactionStatus.PENDING && (entry.type === LedgerEntryType.WITHDRAW || entry.type === LedgerEntryType.FEE)) {
        return sum + (entry.amount < 0 ? -entry.amount : entry.amount);
      }
      return sum;
    }, BigInt(0));

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
    const currency = user?.country === 'KE' ? 'KES' : 'NGN';
    let rate = 1;
    try {
      const rateResult = await this.ratesService.getDisplayRate(currency, 1);
      rate = rateResult.rate;
    } catch (err) {
      this.ratesService['logger']?.warn(`Failed to fetch rate for ${currency} in getBalance, using 1:1 fallback`);
    }

    const localAvailable = Number(ethers.formatUnits(available, 6)) * rate;
    const localPending = Number(ethers.formatUnits(pending, 6)) * rate;

    return {
      available: available.toString(),
      pending: pending.toString(),
      total: (available + pending).toString(),
      currency,
      rate,
      // Internal USD formatting (kept but hidden from main UI logic)
      formattedAvailable: ethers.formatUnits(available, 6),
      formattedPending: ethers.formatUnits(pending, 6),
      formattedTotal: ethers.formatUnits(available + pending, 6),
      // Primary Local Formatting for UI
      localAvailable: localAvailable.toFixed(2),
      localPending: localPending.toFixed(2),
      localTotal: (localAvailable + localPending).toFixed(2),
      formattedLocalAvailable: `${localAvailable.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      formattedLocalPending: `${localPending.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      formattedLocalTotal: `${(localAvailable + localPending).toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
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
      transactions: transactions.map(tx => ({
        ...tx,
        amount: tx.amount.toString()
      })),
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

    // 3. Resolve internal USD amount from provided local amount
    const DECIMALS = 6;
    let amountUSD = dto.amount;
    let rate = 1;

    if (dto.currency && dto.currency !== 'USD') {
      try {
        const rateResult = await this.ratesService.getDisplayRate(dto.currency, dto.amount);
        rate = rateResult.rate;
        amountUSD = dto.amount / rate;
      } catch (err) {
        // Fallback to 1-to-1 if rate fails (safeguard)
        amountUSD = dto.amount;
      }
    }

    // 4. Check Balance (Checks available balance against internal USD amount)
    const balance = await this.getBalance(userId, role);
    const withdrawAmountBigInt = ethers.parseUnits(
      amountUSD.toFixed(DECIMALS),
      DECIMALS,
    );

    if (BigInt(balance.available) < withdrawAmountBigInt) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Amount exceeds available balance',
      });
    }

    // 5. Create Withdrawal Record (LedgerEntry)
    const result = await prisma.$transaction(async (tx) => {
      const providerRef = `withdraw_${userId}_${Date.now()}`;

      // Fee calculation (based on internal USD for ledger integrity)
      const PROVIDER_FEE_PERCENT = 0.01; // 1.0% (Partna)
      const APP_FEE_PERCENT = 0.005; // 0.5% (Dayle)

      const providerFeeUSD = amountUSD * PROVIDER_FEE_PERCENT;
      const appFeeUSD = amountUSD * APP_FEE_PERCENT;
      
      // Calculate final local amounts for the provider
      const totalFeesUSD = providerFeeUSD + appFeeUSD;
      const netAmountUSD = amountUSD - totalFeesUSD;
      const netAmountLocal = netAmountUSD * rate;

      // BigInt conversions for ledger
      const appFeeBigInt = ethers.parseUnits(
        appFeeUSD.toFixed(DECIMALS),
        DECIMALS,
      );

      // 5a. Create gross withdrawal entry (Negative USD for balance)
      const entry = await tx.ledgerEntry.create({
        data: {
          userId,
          type: LedgerEntryType.WITHDRAW,
          amount: -withdrawAmountBigInt, 
          currency: 'USD', // Ledger always tracks USD equivalent
          status: TransactionStatus.PENDING,
          description: `Withdrawal of ${dto.amount} ${dto.currency} to bank ***${dto.bankDetails.accountNumber.slice(-4)}`,
          providerRef,
          partnaFee: providerFeeUSD * rate, // Store fee in local currency for transparency
        },
      });

      // 4b. Create platform fee entry
      await tx.ledgerEntry.create({
        data: {
          userId,
          type: LedgerEntryType.FEE,
          amount: -appFeeBigInt, // Deduction for the app fee
          currency: 'USD', // Fees recorded in USD internally
          status: TransactionStatus.CONFIRMED,
          description: `Withdrawing processing fee for withdrawal ${entry.id}`,
          completedAt: new Date(),
        },
      });

      // Trigger Payment Router (Offramp) with NET amount (LOCAL CURRENCY)
      const user = await tx.user.findUnique({ where: { id: userId } });
      const offrampResult = await this.paymentRouter.initiateOfframp({
        amount: netAmountLocal, 
        currency: dto.currency || 'NGN',
        reference: providerRef,
        bankDetails: {
          account_number: dto.bankDetails.accountNumber,
          bank_code: dto.bankDetails.bankName, // Use bank name if they don't provide code
          account_name: dto.bankDetails.accountName,
        },
        customerEmail: user?.email || '',
      });

      const userCurrency = user?.country === 'KE' ? 'KES' : 'NGN';

      // Simple response body for current state
      const responseBody = {
        id: entry.id,
        createdAt: entry.createdAt,
        type: 'WITHDRAW',
        amount: dto.amount.toString(), // Local amount
        netAmountLocal: netAmountLocal,
        totalFeeLocal: (totalFeesUSD * rate).toString(),
        totalFeePercent: (APP_FEE_PERCENT + PROVIDER_FEE_PERCENT) * 100,
        currency: dto.currency || userCurrency,
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
        message: `Your withdrawal of ${dto.amount} ${dto.currency || userCurrency} has been initiated.`,
        action: '/settings',
      });

      return responseBody;
    });

    return result;
  }

  async getWithdrawalPreview(userId: string, amount: number, targetCurrency: string) {
    const APP_FEE_PERCENT = 0.005; // 0.5%
    const PROVIDER_FEE_PERCENT = 0.01; // 1.0%

    let rate = 1;
    let amountUSD = amount;

    if (targetCurrency !== 'USD') {
      try {
        // Fetch current rate for internal conversion
        const rateResult = await this.ratesService.getDisplayRate(targetCurrency, amount);
        rate = rateResult.rate;
        // If the user provided a local amount (e.g. 50,000 NGN), calculate the USD equivalent
        // Rate is units-per-USD (e.g. 1700 NGN/USD)
        amountUSD = amount / rate;
      } catch (err) {
        rate = 1;
        amountUSD = amount;
      }
    }

    const appFeeUSD = amountUSD * APP_FEE_PERCENT;
    const providerFeeUSD = amountUSD * PROVIDER_FEE_PERCENT;
    const totalFeeUSD = appFeeUSD + providerFeeUSD;
    const netAmountUSD = amountUSD - totalFeeUSD;

    return {
      totalFeePercent: (APP_FEE_PERCENT + PROVIDER_FEE_PERCENT) * 100,
      totalFeeLocal: totalFeeUSD * rate,
      dayleFeePercent: APP_FEE_PERCENT * 100,
      dayleFeeLocal: appFeeUSD * rate,
      partnaFeePercent: PROVIDER_FEE_PERCENT * 100,
      partnaFeeLocal: providerFeeUSD * rate,
      vaultAmountLocal: amount,
      netAmountLocal: netAmountUSD * rate,
      currency: targetCurrency,
      rate,
    };
  }
}
