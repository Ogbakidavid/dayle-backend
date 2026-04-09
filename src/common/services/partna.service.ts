import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface PartnaResponse<T = JsonObject> {
  data?: T;
  message?: string;
}

export interface PartnaErrorPayload {
  message?: string;
  error?: {
    message?: string;
  };
}

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

  private async request<T = JsonObject>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<PartnaResponse<T>> {
    if (!this.apiKey || !this.apiUser) {
      const msg =
        'Partna v4 credentials not yet configured — awaiting account approval.';
      this.logger.warn(msg);
      throw new Error(msg);
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'x-api-user': this.apiUser,
    };
    if (options.headers) {
      const merged = new Headers(options.headers);
      for (const [key, value] of merged.entries()) {
        headers[key] = value;
      }
    }

    const timestamp = new Date().toISOString();
    let lastError: Error | null = null;

    for (let i = 0; i < 2; i++) {
      try {
        const sanitizedBody =
          options.body && typeof options.body === 'string'
            ? this.sanitizePayload(options.body)
            : 'none';
        this.logger.log(
          `[${timestamp}] Partna v4 Request (Try ${i + 1}): ${options.method || 'GET'} ${url} Payload: ${sanitizedBody}`,
        );

        const response = await fetch(url, { ...options, headers });
        const rawResponse = await response.text();

        this.logger.log(
          `[${timestamp}] Partna v4 Response [${response.status}]: ${this.sanitizePayload(rawResponse)}`,
        );

        if (!response.ok) {
          let errorMsg = `Partna request failed (${response.status})`;
          try {
            const parsed = JSON.parse(rawResponse) as PartnaErrorPayload;
            errorMsg = parsed.message || parsed.error?.message || errorMsg;
          } catch {
            errorMsg = rawResponse || errorMsg;
          }
          throw new Error(errorMsg);
        }
        if (!rawResponse) {
          return {};
        }
        return JSON.parse(rawResponse) as PartnaResponse<T>;
      } catch (err: unknown) {
        const error =
          err instanceof Error
            ? err
            : new Error('Unknown Partna request error');
        lastError = error;
        this.logger.error(
          `[${timestamp}] Partna Request Try ${i + 1} Failed: ${error.message}`,
        );

        if (error.message.includes('fetch failed')) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error('Partna request failed');
  }

  private sanitizePayload(payload: string): string {
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      const sensitiveFields = [
        'bvn',
        'kesShortcode',
        'otp',
        'phone',
        'accountNumber',
      ];

      const sanitize = (obj: Record<string, unknown>): void => {
        for (const key in obj) {
          const value = obj[key];
          if (sensitiveFields.includes(key) && typeof value === 'string') {
            obj[key] =
              value.length > 4 ? `*******${value.slice(-4)}` : '*******';
            continue;
          }
          if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value)
          ) {
            sanitize(value as Record<string, unknown>);
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
  async getRate(params: {
    fromCurrency: string;
    toCurrency: string;
    fromAmount: number;
  }) {
    const query = `?fromCurrency=${params.fromCurrency}&toCurrency=${params.toCurrency}&fromAmount=${params.fromAmount}`;
    this.logger.log(`[PARTNA OFFRAMP RATE REQUEST] ${query}`);
    const res = await this.request(`/rate${query}`);
    this.logger.log(`[PARTNA OFFRAMP RATE RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  private sanitizeAccountName(name: string): string {
    if (!name) return name;
    // Partna v4 mock endpoint strictly requires lowercase alphanumeric
    return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }

  /**
   * POST /v4/ramp
   * Initiates onramp or offramp
   */
  async createRamp(body: Record<string, unknown>) {
    const logPrefix =
      body.type === 'cryptoToFiat' ? 'PARTNA OFFRAMP' : 'PARTNA';

    // Sanitize accountName ONLY for onramp (fiatToCrypto).
    // For offramp (cryptoToFiat), the accountName is the real bank account name and may contain spaces.
    const sanitizedBody = { ...body };
    if (sanitizedBody.accountName && body.type !== 'cryptoToFiat') {
      const accountNameValue = sanitizedBody.accountName;
      sanitizedBody.accountName = this.sanitizeAccountName(
        typeof accountNameValue === 'string' ||
          typeof accountNameValue === 'number'
          ? `${accountNameValue}`
          : '',
      );
    }

    this.logger.log(
      `[${logPrefix} RAMP REQUEST] ${JSON.stringify(sanitizedBody)}`,
    );
    const res = await this.request('/ramp', {
      method: 'POST',
      body: JSON.stringify(sanitizedBody),
    });
    this.logger.log(`[${logPrefix} RAMP RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/mock/deposit-fiat
   * Simulates fiat deposit in staging
   */
  async mockDepositFiat(body: {
    accountName: string;
    amount: number;
    currency: string;
    username?: string;
  }) {
    const payload: Record<string, unknown> = {
      accountName: this.sanitizeAccountName(body.accountName),
      amount: body.amount,
      currency: body.currency,
    };
    if (body.username) {
      payload.username = body.username;
    }
    this.logger.log(
      `[PARTNA MOCK DEPOSIT FIAT REQUEST] ${JSON.stringify(payload)}`,
    );
    let res: PartnaResponse;
    try {
      // v4 docs have naming inconsistencies between `/mock/deposit-fiat` and `/mock/fiat-deposit`.
      // Try the OpenAPI endpoint first, then fall back to the guide endpoint.
      res = await this.request('/mock/deposit-fiat', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (firstErr: unknown) {
      const error =
        firstErr instanceof Error
          ? firstErr
          : new Error('Unknown mock fiat deposit error');
      this.logger.warn(
        `[PARTNA MOCK DEPOSIT FIAT] /mock/deposit-fiat failed, retrying /mock/fiat-deposit: ${error.message}`,
      );
      res = await this.request('/mock/fiat-deposit', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    this.logger.log(
      `[PARTNA MOCK DEPOSIT FIAT RESPONSE] ${JSON.stringify(res)}`,
    );
    return res;
  }

  /**
   * POST /v4/mock/deposit
   * Simulates a general crypto deposit in staging
   */
  async mockDeposit(body: Record<string, unknown>) {
    const sanitizedBody: Record<string, unknown> = { ...body };
    if (sanitizedBody.accountName) {
      const accountNameValue = sanitizedBody.accountName;
      sanitizedBody.accountName = this.sanitizeAccountName(
        typeof accountNameValue === 'string' ||
          typeof accountNameValue === 'number'
          ? `${accountNameValue}`
          : '',
      );
    }
    this.logger.log(
      `[PARTNA MOCK DEPOSIT REQUEST] ${JSON.stringify(sanitizedBody)}`,
    );
    const res = await this.request('/mock/deposit', {
      method: 'POST',
      body: JSON.stringify(sanitizedBody),
    });
    this.logger.log(`[PARTNA MOCK DEPOSIT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/account
   * Registers a customer/account in Partna v4
   */
  async createAccount(
    accountName: string,
    email: string,
    fullName?: string,
    type: string = 'personal',
  ) {
    const sanitizedName = this.sanitizeAccountName(accountName);
    this.logger.log(
      `[PARTNA CREATE ACCOUNT REQUEST] accountName: ${sanitizedName}, email: ${email}, fullName: ${fullName}`,
    );
    const res = await this.request('/account', {
      method: 'POST',
      body: JSON.stringify({
        email,
        type,
      }),
    }).catch(async (err) => {
      if (err.message.includes('already exists') || err.message.includes('409')) {
        this.logger.log(`[PARTNA CREATE ACCOUNT CONFLICT] Account ${email} already exists. Searching for original identifier...`);
        // If it already exists, we MUST find the existing accountName/externalRef to avoid 404/500 later
        const existing = await this.findAccountByEmail(email);
        if (existing) {
          // Return a structure compatible with the normal response for recover
          return { data: { accountName: existing.externalRef || existing.accountName || existing.account_name } as any };
        }
      }
      throw err;
    });
    this.logger.log(`[PARTNA CREATE ACCOUNT RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * GET /v4/account/myprofile
   * Fetches the profile of the current Merchant-managed user (x-api-user)
   */
  async getAccountProfile() {
    this.logger.log(`[PARTNA GET PROFILE REQUEST]`);
    const res = await this.request('/account/myprofile');
    return res;
  }

  /**
   * GET /v4/account/account-details
   * Fetches accounts (paginated)
   */
  async getAccountDetails(page: number = 1, perPage: number = 20) {
    this.logger.log(`[PARTNA GET ACCOUNT DETAILS REQUEST] Page ${page}`);
    const res = await this.request<{ 
      accounts?: JsonObject[];
      totalPages?: number;
      total?: number;
      page?: number;
    }>(
      `/account/account-details?page=${page}&perPage=${perPage}`,
    );
    return res.data || { accounts: [] };
  }

  /**
   * Helper to find an account by email across all pages
   */
  async findAccountByEmail(email: string) {
    let currentPage = 1;
    let totalPages = 1;

    const normalizedEmail = email.toLowerCase();

    try {
      do {
        // FIRST: Check if this email already has a Partna account
        // This handles DB wipe / re-registration scenarios
        const data = await this.getAccountDetails(currentPage, 50);
        const accounts = data.accounts || [];
        totalPages = data.totalPages || 1;

        const match = accounts.find(
          (acc: any) => (acc.email || '').toLowerCase() === normalizedEmail
        );

        if (match) return match;
        currentPage++;
      } while (currentPage <= totalPages);
    } catch (e) {
      this.logger.error(`[PARTNA ACCOUNT SEARCH FAILED] ${e.message}`);
    }

    return null;
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
    const sanitizedParams: any = {
      ...params,
      accountName: this.sanitizeAccountName(params.accountName),
    };

    // Map 'MPESA' to 'Safaricom' as Partna v4 only accepts carriers (Safaricom, Airtel, Telkom)
    if (sanitizedParams.kesMobileNetwork === 'MPESA') {
      sanitizedParams.kesMobileNetwork = 'Safaricom';
    }
    this.logger.log(`[PARTNA KYC REQUEST] ${JSON.stringify(sanitizedParams)}`);
    const res = await this.request('/kyc', {
      method: 'POST',
      body: JSON.stringify(sanitizedParams),
    });
    this.logger.log(`[PARTNA KYC RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * PUT /v4/kyc/verification-method
   * Select KYC method (triggers OTP send)
   */
  async selectKycMethod(
    accountName: string,
    method: string,
    currency: string = 'NGN',
  ) {
    const sanitizedName = this.sanitizeAccountName(accountName);
    this.logger.log(
      `[PARTNA KYC SELECT METHOD] accountName: ${sanitizedName}, method: ${method}`,
    );
    const res = await this.request('/kyc/verification-method', {
      method: 'PUT',
      body: JSON.stringify({
        accountName: sanitizedName,
        verificationMethod: method,
        currency,
      }),
    });
    this.logger.log(
      `[PARTNA KYC SELECT METHOD RESPONSE] ${JSON.stringify(res)}`,
    );
    return res;
  }

  /**
   * PUT /v4/kyc/confirm-otp
   * Verify KYC OTP
   */
  async verifyKycOtp(
    accountName: string,
    otp: string,
    currency: string = 'NGN',
  ) {
    const sanitizedName = this.sanitizeAccountName(accountName);
    this.logger.log(
      `[PARTNA KYC VERIFY OTP] accountName: ${sanitizedName}, otp: ${otp}`,
    );
    const res = await this.request('/kyc/confirm-otp', {
      method: 'PUT',
      body: JSON.stringify({
        accountName: sanitizedName,
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
    const sanitizedName = this.sanitizeAccountName(accountName);
    this.logger.log(
      `[PARTNA CREATE VIRTUAL ACCOUNT REQUEST] accountName: ${sanitizedName}, currency: ${currency}`,
    );
    const res = await this.request('/account', {
      method: 'PUT',
      body: JSON.stringify({
        accountName: sanitizedName,
        currency,
      }),
    });
    this.logger.log(
      `[PARTNA CREATE VIRTUAL ACCOUNT RESPONSE] ${JSON.stringify(res)}`,
    );
    return res;
  }

  /**
   * PUT /v4/kyc/confirm-phone
   */
  async confirmPhone(accountName: string, phone: string) {
    const sanitizedName = this.sanitizeAccountName(accountName);
    this.logger.log(
      `[PARTNA PHONE CONFIRM REQUEST] accountName: ${sanitizedName}, phone: ${phone}`,
    );
    const res = await this.request('/kyc/confirm-phone', {
      method: 'PUT',
      body: JSON.stringify({
        accountName: sanitizedName,
        phone,
      }),
    });
    this.logger.log(`[PARTNA PHONE CONFIRM RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * POST /v4/phone
   * Start phone verification for Kenya
   */
  async initiatePhoneVerification(params: {
    country: string;
    accountName: string;
    phoneNumber: string;
    mobileNetwork: string;
  }) {
    const sanitizedName = this.sanitizeAccountName(params.accountName);
    const res = await this.request('/phone', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        accountName: sanitizedName,
      }),
    });
    this.logger.log(
      `[PARTNA PHONE VERIFY START RESPONSE] ${JSON.stringify(res)}`,
    );
    return res;
  }

  /**
   * PUT /v4/phone/verify
   * Select verification method (e.g., sendotp)
   */
  async selectPhoneVerificationMethod(
    phoneID: string,
    method: string = 'sendotp',
  ) {
    const res = await this.request('/phone/verify', {
      method: 'PUT',
      body: JSON.stringify({
        phoneID,
        verificationMethod: method,
      }),
    });
    this.logger.log(
      `[PARTNA PHONE SELECT METHOD RESPONSE] ${JSON.stringify(res)}`,
    );
    return res;
  }

  /**
   * PUT /v4/phone/confirm
   * Confirm OTP for phone verification
   */
  async confirmPhoneOtp(phoneID: string, otp: string) {
    const res = await this.request('/phone/confirm', {
      method: 'PUT',
      body: JSON.stringify({
        phoneID,
        otp,
      }),
    });
    this.logger.log(`[PARTNA PHONE CONFIRM OTP RESPONSE] ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * Get supported banks (v4)
   */
  async getBanks(currency: string = 'NGN'): Promise<any[]> {
    const res = await this.request<any[]>(`/bank?currency=${currency}`);
    return (res.data as any[]) || [];
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
      const payload = res.data as {
        accountName?: string;
        account_name?: string;
        [key: string]: JsonValue | undefined;
      };
      return {
        ...payload,
        account_name: payload.accountName || payload.account_name,
      };
    }
    return res;
  }

  /**
   * LEGACY V2 METHODS
   */

  createPayment(
    amount: number,
    currency: string,
    reference: string,
    bankDetails: unknown,
  ) {
    void bankDetails;
    // This is a placeholder for the legacy v2 createPayment call
    // In a real scenario, this would call the v2 API
    this.logger.log(
      `[LEGACY V2] createPayment: ${amount} ${currency} ref:${reference}`,
    );
    // For now, we simulate a successful call to avoid breaking the app
    return { success: true, reference };
  }

  createCollection(params: {
    amount: number;
    currency: string;
    customerEmail: string;
    customerName: string;
    merchantReference: string;
  }) {
    // Placeholder for legacy v2 /collect endpoint
    this.logger.log(
      `[LEGACY V2] createCollection: ${params.amount} ${params.currency}`,
    );
    return {
      success: true,
      data: {
        accountNumber: '0000000000',
        bankName: 'Mock Bank',
        accountName: 'Mock Account',
        amount: params.amount,
        currency: params.currency,
        reference: params.merchantReference,
        paymentUrl:
          'https://staging-vouchers.ventogram.com/pay/' +
          params.merchantReference,
      },
    };
  }

  createCollectionVoucher(
    amount: number,
    currency: string,
    reference: string,
    customerEmail: string,
    customerName?: string,
  ) {
    void customerEmail;
    void customerName;
    // Placeholder for legacy v2 /vouchers endpoint
    this.logger.log(
      `[LEGACY V2] createCollectionVoucher: ${amount} ${currency}`,
    );
    return {
      pay_url: 'https://staging-vouchers.ventogram.com/pay/' + reference,
      id: reference,
      data: { id: reference },
    };
  }

  async getVerifiedPhone(country: string, accountName: string) {
    return this.request(`/phone?country=${country}&accountName=${accountName}`, {
      method: 'get',
    });
  }
}
