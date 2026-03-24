import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PaycrestService {
  private readonly logger = new Logger(PaycrestService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(
    private configService: ConfigService,
  ) {
    this.baseUrl =
      this.configService.get<string>('PAYCREST_BASE_URL') ||
      'https://api.paycrest.io/v1';
    this.apiKey = this.configService.get<string>('PAYCREST_API_KEY')!;
    this.apiSecret = this.configService.get<string>('PAYCREST_API_SECRET')!;
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'API-Key': this.apiKey,
      ...options.headers,
    } as any;

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        this.logger.error(
          `Paycrest API error: ${response.status} - ${JSON.stringify(error)}`,
        );
        throw new Error(
          error.message ||
            `Paycrest API request failed with status ${response.status}`,
        );
      }
      return response.json();
    } catch (err) {
      this.logger.error(`Paycrest Request Failed: ${err.message}`);
      throw err;
    }
  }

  async getBanks(currency: string = 'NGN') {
    const res = await this.request(`/institutions/${currency}`);
    return res.data || [];
  }

  async resolveBankAccount(
    bankCode: string,
    accountNumber: string,
    currency: string = 'NGN',
  ) {
    // v1 uses /verify-account and requires currency
    const res = await this.request('/verify-account', {
      method: 'POST',
      body: JSON.stringify({
        institution: bankCode,
        accountIdentifier: accountNumber,
        currency,
      }),
    });
    // Paycrest returns { data: { accountName: '...' } }
    // Frontend expects { account_name: '...' }
    if (res.data) {
      return {
        ...res.data,
        account_name: res.data.accountName || res.data.account_name,
      };
    }
    return res;
  }

  async createOrder(params: {
    amount: number;
    currency: string;
    customerEmail: string;
    reference: string;
    rate?: number;
    vaultId: string;
    bankDetails: {
      account_number: string;
      bank_code: string;
      account_name: string;
    };
  }) {
    if (!params.bankDetails?.account_number) {
      throw new BadRequestException('Bank account details are required for withdrawal');
    }

    const recipient = {
      institution: params.bankDetails.bank_code || 'MPESA',
      accountIdentifier: params.bankDetails.account_number,
      accountName: params.bankDetails.account_name || params.customerEmail,
      currency: params.currency,
      memo: params.reference,
    };

    const rate = params.rate || 1;

    const res = await this.request('/sender/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: params.amount,
        token: 'USDC',
        network: 'celo',
        rate,
        recipient,
        reference: params.reference,
        returnAddress: this.configService.get<string>('VAULT_FACTORY_ADDRESS'),
      }),
    });

    return {
      id: res.data?.id || res.id,
      receiveAddress: res.data?.receiveAddress || res.receiveAddress,
      paymentUrl: res.data?.checkout_url || res.checkout_url || res.url,
      status: res.data?.status || res.status,
      validUntil: res.data?.validUntil || res.validUntil,
    };
  }

  async getExchangeRate(amount: number, currency: string = 'KES') {
    // GET /rates/USDC/{amount}/{currency}?network=celo
    return this.request(`/rates/USDC/${amount}/${currency}?network=celo`);
  }
}
