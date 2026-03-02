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
  }) {
    // Standard Paycrest order creation with mandatory fields for onramp/offramp
    return this.request('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: params.amount,
        currency: params.currency,
        email: params.customerEmail,
        reference: params.reference,
        type: params.type,
        token: 'CUSD', // Target token for Dayle
        network: 'CELO', // Target network for Dayle
      }),
    });
  }
}
