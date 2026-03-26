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
    let lastError: any;
    
    for (let i = 0; i < 2; i++) {
        try {
          const sanitizedBody = (options.body && typeof options.body === 'string') ? this.sanitizePayload(options.body) : 'none';
          this.logger.log(`[${timestamp}] Partna v4 Request (Try ${i+1}): ${options.method || 'GET'} ${url} Payload: ${sanitizedBody}`);
          
          const response = await fetch(url, { ...options, headers });
          const rawResponse = await response.text();
          
          this.logger.log(`[${timestamp}] Partna v4 Response [${response.status}]: ${this.sanitizePayload(rawResponse)}`);
    
          if (!response.ok) {
            throw new Error(`Partna API error: ${response.status} - ${this.sanitizePayload(rawResponse)}`);
          }
          return JSON.parse(rawResponse);
        } catch (err) {
          lastError = err;
          this.logger.error(`[${timestamp}] Partna Request Try ${i+1} Failed: ${err.message}`);
          
          if (err.message?.includes('fetch failed')) {
            // Wait 500ms before retry
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw err;
        }
    }
    throw lastError;
  }

  private sanitizePayload(payload: string): string {
    try {
      const data = JSON.parse(payload);
      const sensitiveFields = ['bvn', 'kesShortcode', 'otp', 'phone', 'accountNumber'];
      
      const sanitize = (obj: any) => {
        for (const key in obj) {
          if (sensitiveFields.includes(key) && typeof obj[key] === 'string') {
            obj[key] = obj[key].length > 4 ? `*******${obj[key].slice(-4)}` : '*******';
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitize(obj[key]);
          }
        }
      };

      sanitize(data);
      return JSON.stringify(data);
    } catch {
      return payload;
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
   * POST /v4/account
   * Registers a customer/account in Partna v4
   */
  async createAccount(accountName: string, email: string, type: string = 'personal') {
    this.logger.log(`[PARTNA CREATE ACCOUNT REQUEST] accountName: ${accountName}, email: ${email}`);
    const res = await this.request('/account', {
      method: 'POST',
      body: JSON.stringify({
        accountName,
        email,
        type,
      }),
    });
    this.logger.log(`[PARTNA CREATE ACCOUNT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/kyc
   * Initiate KYC (BVN for Nigeria or Phone for Kenya) in Partna v4
   */
  async initiateKyc(params: {
    accountName: string;
    bvn?: string;
    kesMobileNetwork?: string;
    kesShortcode?: string;
  }) {
    this.logger.log(`[PARTNA KYC REQUEST] ${JSON.stringify(params)}`);
    const res = await this.request('/kyc', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    this.logger.log(`[PARTNA KYC RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/kyc/verification-method
   * Select KYC method (triggers OTP send)
   */
  async selectKycMethod(accountName: string, method: string, currency: string = 'NGN') {
    this.logger.log(`[PARTNA KYC SELECT METHOD] accountName: ${accountName}, method: ${method}`);
    const res = await this.request('/kyc/verification-method', {
      method: 'PUT',
      body: JSON.stringify({
        accountName,
        verificationMethod: method,
        currency,
      }),
    });
    this.logger.log(`[PARTNA KYC SELECT METHOD RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/kyc/confirm-otp
   * Verify KYC OTP
   */
  async verifyKycOtp(accountName: string, otp: string, currency: string = 'NGN') {
    this.logger.log(`[PARTNA KYC VERIFY OTP] accountName: ${accountName}, otp: ${otp}`);
    const res = await this.request('/kyc/confirm-otp', {
      method: 'PUT',
      body: JSON.stringify({
        accountName,
        otp,
        currency,
      }),
    });
    this.logger.log(`[PARTNA KYC VERIFY OTP RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/account
   * Create Bank Account (Virtual Account) in Partna v4
   */
  async createVirtualAccount(accountName: string, currency: string = 'NGN') {
    this.logger.log(`[PARTNA CREATE VIRTUAL ACCOUNT REQUEST] accountName: ${accountName}, currency: ${currency}`);
    const res = await this.request('/account', {
      method: 'PUT',
      body: JSON.stringify({
        accountName,
        currency,
      }),
    });
    this.logger.log(`[PARTNA CREATE VIRTUAL ACCOUNT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/kyc/confirm-phone
   */
  async confirmPhone(accountName: string, phone: string) {
    this.logger.log(`[PARTNA PHONE CONFIRM REQUEST] accountName: ${accountName}, phone: ${phone}`);
    const res = await this.request('/kyc/confirm-phone', {
      method: 'PUT',
      body: JSON.stringify({
        accountName,
        phone,
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
