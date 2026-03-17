import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PartnaService {
  private readonly logger = new Logger(PartnaService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiUser: string;

  constructor(private configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>('PARTNA_BASE_URL') ||
      'https://staging-vouchers.ventogram.com/api/v1';
    this.apiKey = this.configService.get<string>('PARTNA_API_KEY')!;
    this.apiUser = this.configService.get<string>('PARTNA_API_USER')!;
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
      'X-Api-User': this.apiUser,
      ...options.headers,
    } as any;

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        this.logger.error(
          `Partna API error: ${response.status} - ${JSON.stringify(error)}`,
        );
        throw new Error(
          error.message ||
            `Partna API request failed with status ${response.status}`,
        );
      }
      return response.json();
    } catch (err) {
      this.logger.error(`Partna Request Failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * ONRAMP: Create a one-time virtual account for collections (v1 style)
   */
  async createCollection(params: {
    amount: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    merchantReference?: string;
  }) {
    // Note: the v1 /collect endpoint is often the most direct for one-time bank details
    return this.request('/collect', {
      method: 'POST',
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        customerEmail: params.customerEmail,
        customerName: params.customerName,
        merchantReference: params.merchantReference,
        onramp: true,
      }),
    });
  }

  /**
   * ONRAMP: Create a voucher payment link (v2 checkout style)
   */
  async createCollectionVoucher(
    amount: number,
    currency: string,
    reference: string,
    customerEmail: string,
    customerFullName: string = 'Dayle User',
  ) {
    const res = await this.request('/vouchers', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        email: customerEmail,
        fullname: customerFullName,
        merchant: this.apiUser,
      }),
    });

    const isStaging = this.baseUrl.includes('staging');
    const payBaseUrl = isStaging
      ? 'https://staging.ventogram.com'
      : 'https://ventogram.com';
    const callback = this.configService.get<string>('PARTNA_WEBHOOK_URL');

    return {
      ...res,
      pay_url: `${payBaseUrl}/voucher/pay?voucherId=${res.id || res.voucherId}&callback=${callback}`,
    };
  }

  /**
   * ONRAMP: Automated crypto delivery (Redeem & Withdraw)
   */
  async redeemAndWithdraw(params: {
    voucherCode: string;
    walletAddress: string;
    network: string;
    token: string;
  }) {
    // This endpoint redeems the voucher and pushes crypto to a wallet in one call
    return this.request('/voucher/redeem-withdraw', {
      method: 'PATCH',
      body: JSON.stringify({
        voucherCode: params.voucherCode,
        address: params.walletAddress,
        network: params.network, // e.g. 'celo'
        token: params.token, // e.g. 'cUSD'
      }),
    });
  }

  /**
   * OFFRAMP: Get supported banks
   */
  async getBanks(currency: string = 'NGN') {
    return this.request(`/banks?currency=${currency}`);
  }

  /**
   * OFFRAMP: Resolve bank account before payout
   */
  async resolveBankAccount(bankCode: string, accountNumber: string) {
    // Some docs specify /.bank/.resolve while others use /resolve-bank-account
    // We'll stick to the current working one but ensure it's exported for the controller
    return this.request('/resolve-bank-account', {
      method: 'POST',
      body: JSON.stringify({
        bank_code: bankCode,
        account_number: accountNumber,
      }),
    });
  }

  /**
   * OFFRAMP: Create a payment/payout
   */
  async createPayment(
    amount: number,
    currency: string,
    reference: string,
    bankDetails: {
      account_number: string;
      bank_code: string;
      account_name: string;
    },
  ) {
    return this.request('/create-payment', {
      method: 'POST',
      body: JSON.stringify({
        amount,
        currency,
        reference,
        destination_account_number: bankDetails.account_number,
        destination_bank_code: bankDetails.bank_code,
        destination_account_name: bankDetails.account_name,
        type: 'bank-transfer',
      }),
    });
  }
}
