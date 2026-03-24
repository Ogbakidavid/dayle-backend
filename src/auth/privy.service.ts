import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrivyClient, verifyAccessToken } from '@privy-io/node';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet } from 'jose';

@Injectable()
export class PrivyService implements OnModuleInit {
  private client: PrivyClient | undefined;
  private appId: string | undefined;
  private verificationKey: any;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.appId = this.configService.get<string>('PRIVY_APP_ID');
    const appSecret = this.configService.get<string>('PRIVY_APP_SECRET');

    if (!this.appId || !appSecret) {
      console.warn('PRIVY_APP_ID or PRIVY_APP_SECRET not set.');
      return;
    }

    console.log(`Initializing PrivyService with App ID: ${this.appId}`);
    this.client = new PrivyClient({ appId: this.appId, appSecret });

    // Use Privy's JWKS endpoint for access token verification
    this.verificationKey = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${this.appId}/jwks.json`),
    );
  }

  async verifyToken(token: string) {
    if (!this.appId || !this.verificationKey) {
      throw new Error(
        'PrivyService not initialized — missing PRIVY_APP_ID or verificationKey',
      );
    }
    try {
      return await verifyAccessToken({
        access_token: token,
        app_id: this.appId,
        verification_key: this.verificationKey,
      });
    } catch (e) {
      console.error('Privy verifyAccessToken failed:', e);
      throw e;
    }
  }

  async getUser(userId: string) {
    if (!this.client) {
      throw new Error('PrivyService not initialized');
    }
    try {
      // client.users() returns the users service, and _get is the method to fetch by ID
      return await this.client.users()._get(userId);
    } catch (e) {
      console.error(`Privy getUser failed for ${userId}:`, e);
      throw e;
    }
  }
}
