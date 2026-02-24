import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TransactionStatus, LedgerEntryType, VaultStatus } from "../domain/enums";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { BlockchainService } from "../common/services/blockchain.service";

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
  ) {}

  async handlePartnaWebhook(payload: any, signature: string) {
    this.logger.log(`Received Partna webhook: ${JSON.stringify(payload)}`);
    
    // TODO: Implement signature verification if Partna provides a secret
    // For now, we process the status update
    
    const { reference, status, amount, type } = payload;

    // Map Partna status to our internal TransactionStatus
    let internalStatus = TransactionStatus.PENDING;
    if (status === "success") internalStatus = TransactionStatus.CONFIRMED;
    if (status === "failed") internalStatus = TransactionStatus.FAILED;

    const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
      where: { 
        OR: [
          { providerRef: reference },
          { description: { contains: reference } }
        ]
      },
    });

    if (!ledgerEntry) {
      this.logger.warn(`No ledger entry found for Partna reference: ${reference}`);
      return;
    }

    await this.prisma.ledgerEntry.update({
      where: { id: ledgerEntry.id },
      data: { status: internalStatus },
    });

    // If it's a deposit and it's confirmed, update the vault status
    if (type === "collection" && internalStatus === TransactionStatus.CONFIRMED) {
      const vault = await this.prisma.vault.findUnique({
        where: { id: ledgerEntry.vaultId! },
        include: { client: { include: { wallet: true } } }
      });

      if (vault && vault.status === VaultStatus.DRAFT) {
        // Trigger the conversion of the deposited Fiat -> cUSD
        // and send it to the client's `vault.client.wallet.address` via
        // an internal liquidity pool or API request to the Ramp provider.
        this.logger.log(`Triggering Fiat -> cUSD conversion for Vault ${vault.id} to Wallet ${vault.client?.wallet?.address}`);
        
        if (vault.client?.wallet?.address) {
          try {
            // STEP 1: Backend performs the deposit into the smart contract automatically
            this.logger.log(`Automatically depositing ${amount} cUSD into Vault Contract ${vault.vaultAddress}`);
            await this.blockchainService.depositToVault(
              vault.vaultAddress!,
              amount
            );

            // The BlockchainService listener for "Deposited" will catch this and update the vault status to FUNDED.
          } catch (error) {
            this.logger.error(`Failed to auto-deposit to vault ${vault.vaultAddress}:`, error);
          }
        } else {
          this.logger.warn(`Cannot fund vault ${vault.id} because the client has no associated wallet address.`);
        }
      }
    }
  }

  async handlePaycrestWebhook(payload: any, signature: string) {
    this.logger.log(`Received Paycrest webhook: ${JSON.stringify(payload)}`);
    
    // Paycrest uses HMAC-SHA256 signature
    const secret = this.configService.get<string>("PAYCREST_API_SECRET");
    if (secret && signature) {
      const hmac = crypto.createHmac("sha256", secret);
      const digest = hmac.update(JSON.stringify(payload)).digest("hex");
      if (digest !== signature) {
        this.logger.error("Invalid Paycrest signature");
        return;
      }
    }

    const { orderId, status } = payload;
    
    // Logic for updating Paycrest orders
    // Similar to Partna, find ledger entry and update
  }
}
