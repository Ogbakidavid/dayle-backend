import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PartnaService } from '../common/services/partna.service';

interface RateCache {
  rate: number;
  rateKey?: string;
  timestamp: number;
}

@Injectable()
export class RatesService {
  private readonly logger = new Logger(RatesService.name);
  private displayCache: Map<string, RateCache> = new Map();
  private transactionCache: Map<string, RateCache> = new Map();

  constructor(
    private prisma: PrismaService,
    private partnaService: PartnaService,
  ) {}

  /**
   * TYPE 1: Display rate (informational)
   * Cache: 60s. Fallback: 5 mins stale.
   */
  async getDisplayRate(
    currency: string,
    amount: number,
  ): Promise<{ rate: number; isStale: boolean }> {
    const cacheKey = currency.toUpperCase();
    const cached = this.displayCache.get(cacheKey);

    const now = Date.now();
    if (cached && now - cached.timestamp < 60000) {
      return { rate: cached.rate, isStale: false };
    }

    try {
      const { rate } = await this.fetchLiveRate(currency, amount);
      this.displayCache.set(cacheKey, { rate, timestamp: now });
      return { rate, isStale: false };
    } catch (error) {
      this.logger.warn(
        `Display rate fetch failed for ${currency}: ${error.message}`,
      );

      if (cached && now - cached.timestamp < 300000) {
        return { rate: cached.rate, isStale: true };
      }

      throw new BadRequestException(
        "We're having trouble fetching the current exchange rate. Please try again in a moment.",
      );
    }
  }

  /**
   * TYPE 2: Transaction rate (actual execution)
   */
  async getTransactionRate(
    currency: string,
    amount: number,
    vaultId: string,
    txnType: 'funding' | 'withdrawal',
  ): Promise<{ rate: number; rateKey?: string }> {
    const cacheKey = `${currency.toUpperCase()}_${amount}_${vaultId}_${txnType}`;
    const now = Date.now();

    if (txnType === 'funding') {
      const cached = this.transactionCache.get(cacheKey);
      if (cached && now - cached.timestamp < 30000) {
        return { rate: cached.rate, rateKey: cached.rateKey };
      }
    }

    try {
      const { rate, rateKey } = await this.fetchLiveRate(
        currency,
        amount,
        txnType,
      );

      if (txnType === 'funding') {
        this.transactionCache.set(cacheKey, { rate, rateKey, timestamp: now });
      }

      // Record in database (Audit Trail)
      await this.prisma.exchangeRateLog.create({
        data: {
          currency: currency.toUpperCase(),
          amount,
          localAmount: amount * rate,
          rate,
          source: 'Partna v4',
          type: 'TRANSACTION' as any,
          vaultId,
        },
      });

      return { rate, rateKey };
    } catch (error) {
      this.logger.error(
        `Transaction rate fetch failed for ${currency}: ${error.message}`,
      );

      const credentialError =
        'Partna v4 credentials not yet configured — awaiting account approval.';
      if (error.message === credentialError) {
        throw new BadRequestException(credentialError);
      }

      throw new BadRequestException(
        "We're having trouble fetching the current exchange rate. Please try again in a moment.",
      );
    }
  }

  private async fetchLiveRate(
    currency: string,
    amount: number,
    txnType?: string,
  ): Promise<{ rate: number; rateKey?: string }> {
    const curr = currency.toUpperCase();

    if (curr === 'NGN' || curr === 'KES') {
      // In v4:
      // Onramp: fromCurrency=NGN (or KES), toCurrency=USDC
      // Offramp: fromCurrency=USDC, toCurrency=NGN (or KES)

      let fromCurrency = curr;
      let toCurrency = 'USDC';

      if (txnType === 'withdrawal') {
        fromCurrency = 'USDC';
        toCurrency = curr;
      }

      const res = await this.partnaService.getRate({
        fromCurrency,
        toCurrency,
        fromAmount: amount,
      });

      const pair = `${fromCurrency}_to_${toCurrency}`;
      const rateData = res.data?.rate?.[pair];

      if (!rateData) {
        this.logger.error(
          `Rate data for ${pair} not found in Partna response: ${JSON.stringify(res)}`,
        );
        throw new Error(`Rate data for ${pair} not available`);
      }

      return {
        rate: rateData.rate,
        rateKey: rateData.key,
      };
    }

    throw new BadRequestException(
      `Unsupported currency for live rates: ${currency}`,
    );
  }
}
