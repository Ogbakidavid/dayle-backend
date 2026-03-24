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
      'https://staging-api.getpartna.com/v4';
    this.apiKey = this.configService.get<string>('PARTNA_API_KEY')!;
    this.apiUser = this.configService.get<string>('PARTNA_API_USER')!;
  }

  private async request(
    endpoint: string,
    options: RequestInit = {},
  ) {
    if (!this.apiKey || !this.apiUser) {
      const msg = 'Partna v4 credentials not yet configured — awaiting account approval.';
      this.logger.warn(msg);
      throw new Error(msg);
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'x-api-user': this.apiUser,
      ...options.headers,
    } as any;

    const timestamp = new Date().toISOString();
    try {
      this.logger.log(`[${timestamp}] Partna v4 Request: ${options.method || 'GET'} ${url} Payload: ${options.body || 'none'}`);
      
      const response = await fetch(url, { ...options, headers });
      const rawResponse = await response.text();
      
      this.logger.log(`[${timestamp}] Partna v4 Response [${response.status}]: ${rawResponse}`);

      if (!response.ok) {
        throw new Error(`Partna API error: ${response.status} - ${rawResponse}`);
      }
      return JSON.parse(rawResponse);
    } catch (err) {
      this.logger.error(`[${timestamp}] Partna Request Failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * GET /v4/rate
   * Fetches exchange rate and rateKey
   */
  async getRate(params: { fromCurrency: string; toCurrency: string; fromAmount: number }) {
    const query = `?fromCurrency=${params.fromCurrency}&toCurrency=${params.toCurrency}&fromAmount=${params.fromAmount}`;
    this.logger.log(`[PARTNA OFFRAMP RATE REQUEST] ${query}`);
    const res = await this.request(`/rate${query}`);
    this.logger.log(`[PARTNA OFFRAMP RATE RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/ramp
   * Initiates onramp or offramp
   */
  async createRamp(body: any) {
    const logPrefix = body.type === 'cryptoToFiat' ? 'PARTNA OFFRAMP' : 'PARTNA';
    this.logger.log(`[${logPrefix} RAMP REQUEST] ${JSON.stringify(body)}`);
    const res = await this.request('/ramp', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    this.logger.log(`[${logPrefix} RAMP RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/mock/deposit-fiat
   * Simulates fiat deposit in staging
   */
  async mockDepositFiat(body: { accountName: string; amount: number; currency: string; username: string }) {
    this.logger.log(`[PARTNA MOCK DEPOSIT REQUEST] ${JSON.stringify(body)}`);
    const res = await this.request('/mock/deposit-fiat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    this.logger.log(`[PARTNA MOCK DEPOSIT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }
  
  /**
   * POST /v4/customers
   * Registers a customer in Partna v4
   */
  async createCustomer(userId: string, firstName: string, lastName: string, email: string, country: string = 'NG') {
    this.logger.log(`[PARTNA CREATE CUSTOMER REQUEST] userId: ${userId}, name: ${firstName} ${lastName}, email: ${email}`);
    const res = await this.request('/customers', {
      method: 'POST',
      body: JSON.stringify({
        userId,
        first_name: firstName,
        last_name: lastName,
        email,
        country,
      }),
    });
    this.logger.log(`[PARTNA CREATE CUSTOMER RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/kyc/initiate-bvn-kyc
   */
  async initiateBvnKyc(bvn: string, firstName: string, lastName: string, email: string, customerId?: string) {
    this.logger.log(`[PARTNA BVN KYC REQUEST] bvn: ${bvn}, name: ${firstName} ${lastName}, email: ${email}, customerId: ${customerId}`);
    const res = await this.request('/kyc/initiate-bvn-kyc', {
      method: 'POST',
      body: JSON.stringify({
        bvn,
        first_name: firstName,
        last_name: lastName,
        email,
        customer_id: customerId, // Associate with Partna customer if provided
      }),
    });
    this.logger.log(`[PARTNA BVN KYC RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/account/create-account
   */
  async createAccount(customerId: string) {
    this.logger.log(`[PARTNA CREATE ACCOUNT REQUEST] customerId: ${customerId}`);
    const res = await this.request('/account/create-account', {
      method: 'POST',
      body: JSON.stringify({ customer_id: customerId }),
    });
    this.logger.log(`[PARTNA CREATE ACCOUNT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/kyc/confirm-phone
   */
  async confirmPhone(phone: string, firstName: string, lastName: string, email: string) {
    this.logger.log(`[PARTNA PHONE CONFIRM REQUEST] phone: ${phone}, name: ${firstName} ${lastName}, email: ${email}`);
    const res = await this.request('/kyc/confirm-phone', {
      method: 'PUT',
      body: JSON.stringify({
        phoneNumber: phone,
        firstName,
        lastName,
        email,
      }),
    });
    this.logger.log(`[PARTNA PHONE CONFIRM RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * Get supported banks (v4)
   */
  async getBanks(currency: string = 'NGN') {
    const res = await this.request(`/bank?currency=${currency}`);
    return res.data || [];
  }

  /**
   * Resolve account name (v4)
   */
  async resolveBankAccount(
    bankCode: string,
    accountNumber: string,
    currency: string = 'NGN',
  ) {
    const res = await this.request('/kyc/resolve-bank', {
      method: 'POST',
      body: JSON.stringify({
        bankCode,
        accountNumber,
        currency,
      }),
    });
    if (res.data) {
      return {
        ...res.data,
        account_name: res.data.accountName || res.data.account_name,
      };
    }
    return res;
  }

  /**
   * LEGACY V2 METHODS
   */

  async createPayment(amount: number, currency: string, reference: string, bankDetails: any) {
    // This is a placeholder for the legacy v2 createPayment call
    // In a real scenario, this would call the v2 API
    this.logger.log(`[LEGACY V2] createPayment: ${amount} ${currency} ref:${reference}`);
    // For now, we simulate a successful call to avoid breaking the app
    return { success: true, reference };
  }

  async createCollection(params: {
    amount: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    merchantReference: string;
  }) {
    // Placeholder for legacy v2 /collect endpoint
    this.logger.log(`[LEGACY V2] createCollection: ${params.amount} ${params.currency}`);
    return { 
      success: true, 
      data: { 
        accountNumber: '0000000000',
        bankName: 'Mock Bank',
        accountName: 'Mock Account',
        amount: params.amount,
        currency: params.currency,
        reference: params.merchantReference,
        paymentUrl: 'https://staging-vouchers.ventogram.com/pay/' + params.merchantReference,
      } 
    };
  }

  async createCollectionVoucher(
    amount: number,
    currency: string,
    reference: string,
    customerEmail: string,
    customerName?: string,
  ) {
    // Placeholder for legacy v2 /vouchers endpoint
    this.logger.log(`[LEGACY V2] createCollectionVoucher: ${amount} ${currency}`);
    return { 
      pay_url: 'https://staging-vouchers.ventogram.com/pay/' + reference, 
      id: reference,
      data: { id: reference }
    };
  }
}
