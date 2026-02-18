import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PartnaService {
  private readonly logger = new Logger(PartnaService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiUser: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>("PARTNA_BASE_URL") || "https://api.getpartna.com/biz/v1";
    this.apiKey = this.configService.get<string>("PARTNA_API_KEY")!;
    this.apiUser = this.configService.get<string>("PARTNA_API_USER")!;
  }

  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      "X-Api-Key": this.apiKey,
      "X-Api-User": this.apiUser,
      ...options.headers,
    } as any;

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        this.logger.error(`Partna API error: ${response.status} - ${JSON.stringify(error)}`);
        throw new Error(error.message || `Partna API request failed with status ${response.status}`);
      }
      return response.json();
    } catch (err) {
      this.logger.error(`Partna Request Failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * ONRAMP: Create a voucher for collections
   */
  async createCollectionVoucher(amount: number, currency: string, reference: string, customerEmail: string) {
    return this.request("/collection/voucher", {
      method: "POST",
      body: JSON.stringify({
        amount,
        currency,
        reference,
        customer_email: customerEmail,
        callback_url: this.configService.get<string>("PARTNA_WEBHOOK_URL"),
      }),
    });
  }

  /**
   * OFFRAMP: Resolve bank account before payout
   */
  async resolveBankAccount(bankCode: string, accountNumber: string) {
    return this.request("/resolve-bank-account", {
      method: "POST",
      body: JSON.stringify({
        bank_code: bankCode,
        account_number: accountNumber,
      }),
    });
  }

  /**
   * OFFRAMP: Create a payment/payout
   */
  async createPayment(amount: number, currency: string, reference: string, bankDetails: {
    account_number: string;
    bank_code: string;
    account_name: string;
  }) {
    return this.request("/create-payment", {
      method: "POST",
      body: JSON.stringify({
        amount,
        currency,
        reference,
        destination_account_number: bankDetails.account_number,
        destination_bank_code: bankDetails.bank_code,
        destination_account_name: bankDetails.account_name,
        type: "bank-transfer",
      }),
    });
  }
}
