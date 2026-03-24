import { Injectable, Logger } from '@nestjs/common';
import { PartnaService } from './partna.service';
import { PaycrestService } from './paycrest.service';
import { RatesService } from '../../rates/rates.service';

export enum PaymentProvider {
  PARTNA = 'partna',
  PAYCREST = 'paycrest',
}

@Injectable()
export class PaymentRouter {
  private readonly logger = new Logger(PaymentRouter.name);

  constructor(
    private partna: PartnaService,
    private paycrest: PaycrestService,
    private ratesService: RatesService,
  ) {}

  /**
   * Determine primary provider based on country/currency
   * Partna supports specific African corridors (NGN, GHS, KES)
   * Paycrest covers all others and acts as the primary for the rest.
   */
  private getPrimaryProvider(
    currency: string,
    country?: string,
  ): PaymentProvider {
    const uc = currency.toUpperCase();
    if (uc === 'GHS') return PaymentProvider.PAYCREST;
    if (['NGN', 'KES'].includes(uc)) {
      return PaymentProvider.PARTNA;
    }
    return PaymentProvider.PAYCREST;
  }

  /**
   * ONRAMP: Initiate collection via Partna only
   */
  async initiateOnramp(params: {
    amount: number;
    currency: string;
    reference: string;
    customerEmail: string;
    customerFullName?: string;
    country?: string;
    walletAddress?: string;
    vaultId: string;
  }) {
    this.logger.log(`Attempting onramp via Partna`);
    return await this.callOnramp(PaymentProvider.PARTNA, params);
  }

  private async callOnramp(provider: PaymentProvider, params: any) {
    if (provider === PaymentProvider.PARTNA) {
      // Use createCollection for a more automated/direct experience if currency is supported
      try {
        const res = await this.partna.createCollection({
          amount: params.amount,
          currency: params.currency,
          customerEmail: params.customerEmail,
          customerName: params.customerFullName || 'Dayle User',
          merchantReference: params.reference,
        });

        // Return bank details so the UI can display them directly
        return {
          provider,
          bankDetails: res.data
            ? {
                accountNumber: res.data.accountNumber,
                bankName: res.data.bankName,
                accountName: res.data.accountName,
                amount: res.data.amount,
                currency: res.data.currency,
                reference: res.data.reference,
              }
            : null,
          paymentUrl: res.data?.paymentUrl || null,
          providerRef: res.data?.reference || params.reference,
        };
      } catch (err) {
        // Fallback to voucher link if /collect fails
        this.logger.warn(
          `Partna /collect failed: ${err.message}. Falling back to /vouchers.`,
        );
        const res = await this.partna.createCollectionVoucher(
          params.amount,
          params.currency,
          params.reference,
          params.customerEmail,
          params.customerFullName,
        );
        return {
          provider,
          paymentUrl: res.pay_url,
          providerRef: res.data?.id || res.id || params.reference,
        };
      }
    } else {
      // Paycrest no longer supports onramp in this implementation
      throw new Error(`Onramp not supported via provider: ${provider}`);
    }
  }

  /**
   * OFFRAMP: Initiate payout with failover
   */
  async initiateOfframp(params: {
    amount: number;
    currency: string;
    reference: string;
    bankDetails: {
      account_number: string;
      bank_code: string;
      account_name: string;
    };
    customerEmail: string;
    vaultId?: string;
  }) {
    const primary = PaymentProvider.PAYCREST;
    const secondary = PaymentProvider.PARTNA;

    try {
      this.logger.log(`Attempting offramp via primary provider: ${primary}`);
      return await this.callOfframp(primary, params);
    } catch (err) {
      this.logger.warn(
        `Primary provider ${primary} failed, attempting failover to ${secondary}. Error: ${err.message}`,
      );
      try {
        return await this.callOfframp(secondary, params);
      } catch (failoverErr) {
        this.logger.error(
          `Both providers failed for offramp: ${failoverErr.message}`,
        );
        throw failoverErr;
      }
    }
  }

  private async callOfframp(provider: PaymentProvider, params: any) {
    if (provider === PaymentProvider.PARTNA) {
      await this.partna.createPayment(
        params.amount,
        params.currency,
        params.reference,
        params.bankDetails,
      );
      return { provider, status: 'pending', providerRef: params.reference };
    } else {
      let rate: number | undefined;
      if (params.currency === 'KES' && params.vaultId) {
        const rateResult = await this.ratesService.getTransactionRate(
          'KES',
          params.amount,
          params.vaultId,
          'withdrawal',
        );
        rate = rateResult.rate;
      }

      const res = await this.paycrest.createOrder({
        amount: params.amount,
        currency: params.currency,
        customerEmail: params.customerEmail,
        reference: params.reference,
        bankDetails: params.bankDetails,
        vaultId: params.vaultId,
        rate: rate,
      });
      return {
        provider,
        status: 'pending',
        providerRef: res.id || params.reference,
      };
    }
  }
}
