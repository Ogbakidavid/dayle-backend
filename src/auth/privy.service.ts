import { Injectable, OnModuleInit } from "@nestjs/common";
import { verifyAccessToken } from "@privy-io/node";
import { ConfigService } from "@nestjs/config";
import { createRemoteJWKSet } from "jose";

@Injectable()
export class PrivyService implements OnModuleInit {
  private appId: string | undefined;
  private appSecret: string | undefined;
  private verificationKey: any;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    this.appId = this.configService.get<string>("PRIVY_APP_ID");
    this.appSecret = this.configService.get<string>("PRIVY_APP_SECRET");

    if (!this.appId || !this.appSecret) {
      console.warn("PRIVY_APP_ID or PRIVY_APP_SECRET not set.");
      return;
    }

    console.log(`Initializing PrivyService with App ID: ${this.appId}`);

    // Use Privy's JWKS endpoint for access token verification
    this.verificationKey = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${this.appId}/jwks.json`)
    );
  }

  async verifyToken(token: string) {
    if (!this.verificationKey) {
      throw new Error("PrivyService not initialized — missing PRIVY_APP_ID or PRIVY_APP_SECRET");
    }
    try {
      return await verifyAccessToken({
        access_token: token,
        app_id: this.appId as string,
        verification_key: this.verificationKey,
      });
    } catch (e) {
      console.error("Privy verifyAccessToken failed:", e);
      throw e;
    }
  }

  async getUser(userId: string) {
    if (!this.appId || !this.appSecret) {
      throw new Error("PrivyService not initialized");
    }
    try {
      // Use Privy REST API directly with Basic auth
      const credentials = Buffer.from(`${this.appId}:${this.appSecret}`).toString("base64");
      const response = await fetch(`https://api.privy.io/v1/users/${userId}`, {
        method: "GET",
        headers: {
          Authorization: `Basic ${credentials}`,
          "privy-app-id": this.appId,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Privy API error ${response.status}: ${error}`);
      }

      return await response.json();
    } catch (e) {
      console.error(`Privy getUser failed for ${userId}:`, e);
      throw e;
    }
  }
}
