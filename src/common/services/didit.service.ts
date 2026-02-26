import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class DiditService {
  private readonly logger = new Logger(DiditService.name);
  private readonly apiUrl = 'https://verification.didit.me/v3/session/';

  constructor(private configService: ConfigService) {}

  async createSession(vendorData: string, callbackUrl: string) {
    const apiKey = this.configService.get<string>('DIDIT_API_KEY');
    const workflowId = this.configService.get<string>('DIDIT_WORKFLOW_ID');

    if (!apiKey || !workflowId) {
      this.logger.error('Missing Didit API Key or Workflow ID in environment variables');
      throw new HttpException('DIDIT_CONFIG_MISSING', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          workflow_id: workflowId,
          callback: callbackUrl,
          vendor_data: vendorData, // typically the user ID
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        this.logger.error(`Failed to create Didit session: ${JSON.stringify(data)}`);
        throw new HttpException(data, response.status);
      }

      return data; // Returns session_id, session_token, verification_url, etc.
    } catch (error) {
      this.logger.error(`Error in Didit createSession: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to create verification session',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // Didit Webhook Signature Verification
  verifySignature(rawBody: string, signatureHeader: string): boolean {
    const secret = this.configService.get<string>('DIDIT_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('DIDIT_WEBHOOK_SECRET is not configured');
      return false;
    }

    try {
      // Didit X-Signature-V2 format usually has timestamp and signature
      // Format: t=<timestamp>,v1=<signature>
      const parts = signatureHeader.split(',');
      const tPart = parts.find(p => p.startsWith('t='));
      const v1Part = parts.find(p => p.startsWith('v1='));

      if (!tPart || !v1Part) return false;

      const timestamp = tPart.split('=')[1];
      const signature = v1Part.split('=')[1];

      // Recreate signature
      const payloadToSign = `${timestamp}.${rawBody}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadToSign)
        .digest('hex');

      // Secure compare
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(signature)
      );
    } catch (error) {
      this.logger.error(`Error verifying Didit signature: ${error.message}`);
      return false;
    }
  }
}
