import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PaycrestService {
  private readonly logger = new Logger(PaycrestService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(private configService: ConfigService) {
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

  async createOrder(params: {
    amount: number;
    currency: string;
    customerEmail: string;
    reference: string;
    type: 'onramp' | 'offramp';
    walletAddress?: string;
    bankDetails?: {
      account_number: string;
      bank_code: string;
      account_name: string;
    };
  }) {
    const isOnramp = params.type === 'onramp';
    
    const recipient = isOnramp ? {
      institution: 'WALLET',
      accountIdentifier: params.walletAddress,
      accountName: params.customerEmail,
      currency: params.currency,
      memo: params.reference,
    } : {
      institution: 'BANK', 
      accountIdentifier: params.bankDetails?.account_number || 'MOCK_ACCOUNT',
      accountName: params.bankDetails?.account_name || params.customerEmail,
      currency: params.currency,
      memo: params.reference,
    };

    const res = await this.request('/sender/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: params.amount,
        token: 'CUSD', // Always cUSD tokens for Dayle
        network: 'celo', // Celo network
        rate: 1, // Exchange rate (mocked for now)
        recipient,
        reference: params.reference,
      }),
    });

    return {
      id: res.data?.id || res.id,
      receiveAddress: res.data?.receiveAddress || res.receiveAddress,
      paymentUrl: res.data?.checkout_url || res.checkout_url || res.url,
      status: res.data?.status || res.status,
    };
  }
}
