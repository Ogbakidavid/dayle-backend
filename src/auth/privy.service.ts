import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrivyClient } from "@privy-io/server-auth";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class PrivyService implements OnModuleInit {
  private privy: PrivyClient;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const appId = this.configService.get<string>("PRIVY_APP_ID");
    const appSecret = this.configService.get<string>("PRIVY_APP_SECRET");

    if (!appId || !appSecret) {
      console.warn("PRIVY_APP_ID or PRIVY_APP_SECRET not set. PrivyService will not function correctly.");
      return;
    }
    
    console.log(`Initializing PrivyClient with App ID: ${appId}`);
    this.privy = new PrivyClient(appId, appSecret);
  }

  async verifyToken(token: string) {
    if (!this.privy) {
      console.error("PrivyClient not initialized during verifyToken call");
      throw new Error("PrivyClient not initialized");
    }
    try {
        return await this.privy.verifyAuthToken(token);
    } catch (e) {
        console.error("Privy verifyAuthToken failed:", e);
        throw e;
    }
  }

  async getUser(userId: string) {
    if (!this.privy) {
      throw new Error("PrivyClient not initialized");
    }
    try {
        return await this.privy.getUser(userId);
    } catch (e) {
        console.error(`Privy getUser failed for ${userId}:`, e);
        throw e;
    }
  }

  async createWallet(email: string) {
    // Note: Creating wallets strictly via backend API might be limited depending on the plan/SDK.
    // Usually, wallets are created on frontend login or via specific server-side wallet APIs.
    // Keeping mock return for now if specific server creation isn't needed, or implementing if strictly required.
    // For now, we'll assume the frontend creation flow handles the wallet initially.
    
    // If we need to create a wallet for a user programmatically (server-side wallet):
    /*
    const wallet = await this.privy.wallet.create({ chainType: 'ethereum' });
    return { address: wallet.address, did: wallet.id };
    */

    // Reverting to mock-like behavior for "creation" if it's just about returning data structure,
    // OR if we want to actually create one:
    const randomHex = (length: number) =>
      Array.from({ length }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("");

    return {
      address: `0x${randomHex(40)}`,
      did: `did:privy:${randomHex(20)}`,
    };
  }
}
