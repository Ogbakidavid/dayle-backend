import { Injectable, Logger } from "@nestjs/common";
import { PartnaService } from "./partna.service";
import { PaycrestService } from "./paycrest.service";

export enum PaymentProvider {
  PARTNA = "partna",
  PAYCREST = "paycrest",
}

@Injectable()
export class PaymentRouter {
  private readonly logger = new Logger(PaymentRouter.name);

  constructor(
    private partna: PartnaService,
    private paycrest: PaycrestService,
  ) {}

  /**
   * Determine primary provider based on country/currency
   * Partna supports specific African corridors (NGN, GHS, KES)
   * Paycrest covers all others and acts as the primary for the rest.
   */
  private getPrimaryProvider(currency: string, country?: string): PaymentProvider {
    const partnaSupported = ["NGN", "GHS", "KES"];
    if (partnaSupported.includes(currency.toUpperCase())) {
      return PaymentProvider.PARTNA;
    }
    return PaymentProvider.PAYCREST;
  }

  /**
   * ONRAMP: Initiate collection with failover
   */
  async initiateOnramp(params: {
    amount: number;
    currency: string;
    reference: string;
    customerEmail: string;
    country?: string;
  }) {
    const primary = this.getPrimaryProvider(params.currency, params.country);
    const secondary = primary === PaymentProvider.PARTNA ? PaymentProvider.PAYCREST : PaymentProvider.PARTNA;

    try {
      this.logger.log(`Attempting onramp via primary provider: ${primary}`);
      return await this.callOnramp(primary, params);
    } catch (err) {
      this.logger.warn(`Primary provider ${primary} failed, attempting failover to ${secondary}. Error: ${err.message}`);
      try {
        return await this.callOnramp(secondary, params);
      } catch (failoverErr) {
        this.logger.error(`Both providers failed for onramp: ${failoverErr.message}`);
        throw failoverErr;
      }
    }
  }

  private async callOnramp(provider: PaymentProvider, params: any) {
    if (provider === PaymentProvider.PARTNA) {
      const res = await this.partna.createCollectionVoucher(
        params.amount,
        params.currency,
        params.reference,
        params.customerEmail
      );
      return { provider, paymentUrl: res.pay_url || res.url, providerRef: params.reference };
    } else {
      const res = await this.paycrest.createOrder({
        amount: params.amount,
        currency: params.currency,
        customerEmail: params.customerEmail,
        reference: params.reference,
        type: "onramp",
      });
      return { provider, paymentUrl: res.checkout_url || res.url, providerRef: res.id || params.reference };
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
  }) {
    const primary = this.getPrimaryProvider(params.currency);
    const secondary = primary === PaymentProvider.PARTNA ? PaymentProvider.PAYCREST : PaymentProvider.PARTNA;

    try {
      this.logger.log(`Attempting offramp via primary provider: ${primary}`);
      return await this.callOfframp(primary, params);
    } catch (err) {
      this.logger.warn(`Primary provider ${primary} failed, attempting failover to ${secondary}. Error: ${err.message}`);
      try {
        return await this.callOfframp(secondary, params);
      } catch (failoverErr) {
        this.logger.error(`Both providers failed for offramp: ${failoverErr.message}`);
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
        params.bankDetails
      );
      return { provider, status: "pending", providerRef: params.reference };
    } else {
      const res = await this.paycrest.createOrder({
        amount: params.amount,
        currency: params.currency,
        customerEmail: params.customerEmail,
        reference: params.reference,
        type: "offramp",
      });
      return { provider, status: "pending", providerRef: res.id || params.reference };
    }
  }
}
