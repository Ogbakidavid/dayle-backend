import { Injectable, OnModuleInit } from "@nestjs/common";
import { PrivyClient, PrivyClientOptions, verifyAuthToken } from "@privy-io/node";
import { ConfigService } from "@nestjs/config";
import { createRemoteJWKSet } from "jose";

@Injectable()
export class PrivyService implements OnModuleInit {
  private privy: PrivyClient;
  private verificationKey: any; 

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const appId = this.configService.get<string>("PRIVY_APP_ID");
    const appSecret = this.configService.get<string>("PRIVY_APP_SECRET");
    const apiUrl = this.configService.get<string>("PRIVY_API_URL") || "https://auth.privy.io/api/v1";

    if (!appId || !appSecret) {
      console.warn("PRIVY_APP_ID or PRIVY_APP_SECRET not set. PrivyService will not function correctly.");
      return;
    }
    
    console.log(`Initializing PrivyClient with App ID: ${appId}`);
    this.privy = new PrivyClient({ appId, appSecret });
    
    // Create the JWKS verification key manually using jose since createPrivyAppJWKS is not exported
    this.verificationKey = createRemoteJWKSet(new URL(`${apiUrl}/apps/${appId}/jwks.json`));
  }

  async verifyToken(token: string) {
    if (!this.privy) {
      console.error("PrivyClient not initialized during verifyToken call");
      throw new Error("PrivyClient not initialized");
    }
    const appId = this.configService.get<string>("PRIVY_APP_ID");
    if (!appId) throw new Error("PRIVY_APP_ID not set");

    try {
        // Use standalone verifyAuthToken with the manually created key
        return await verifyAuthToken({
          auth_token: token,
          app_id: appId,
          verification_key: this.verificationKey
        });
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
        // Access _get method from the Users resource (inherited from APIResource/Users)
        // We cast to any or use element access because it's prefixed with _
        return await (this.privy.users() as any)._get(userId);
    } catch (e) {
        console.error(`Privy getUser failed for ${userId}:`, e);
        throw e;
    }
  }
}
