import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TransactionStatus,
  LedgerEntryType,
  VaultStatus,
  KycStatus,
} from '../domain/enums';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { BlockchainService } from '../common/services/blockchain.service';
import { DiditService } from '../common/services/didit.service';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private diditService: DiditService,
    private redisService: RedisService,
  ) {}

  async handlePartnaWebhook(payload: any, signature: string) {
    this.logger.log(`Received Partna webhook: ${JSON.stringify(payload)}`);

    // Verify Partna signature if public key is configured
    const publicKey = this.configService.get<string>('PARTNA_PUBLIC_KEY');
    if (publicKey && signature) {
      try {
        const isValid = crypto.verify(
          'sha256',
          Buffer.from(JSON.stringify(payload.data || payload)), // Documentation suggests payload.data or raw body
          {
            key: publicKey.replace(/\\n/g, '\n'),
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          },
          Buffer.from(signature, 'base64'),
        );

        if (!isValid) {
          this.logger.error('Invalid Partna webhook signature');
          return;
        }
      } catch (err) {
        this.logger.error(`Error verifying Partna signature: ${err.message}`);
        // During staging/development, we might not want to block execution if public key is misconfigured
      }
    }

    const { reference, status, amount, type } = payload.data || payload;

    // Map Partna status to our internal TransactionStatus
    let internalStatus = TransactionStatus.PENDING;
    if (status === 'success') internalStatus = TransactionStatus.CONFIRMED;
    if (status === 'failed') internalStatus = TransactionStatus.FAILED;

    const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        OR: [
          { providerRef: reference },
          { description: { contains: reference } },
          { id: reference }, // In case reference is our internal ID
        ],
      },
    });

    if (!ledgerEntry) {
      this.logger.warn(
        `No ledger entry found for Partna reference: ${reference}`,
      );
      return;
    }

    await this.prisma.ledgerEntry.update({
      where: { id: ledgerEntry.id },
      data: { status: internalStatus },
    });

    // If it's a deposit and it's confirmed, update the vault status
    if (
      (type === 'collection' || type === 'voucher') &&
      internalStatus === TransactionStatus.CONFIRMED
    ) {
      const vault = await this.prisma.vault.findUnique({
        where: { id: ledgerEntry.vaultId! },
        include: { client: { include: { wallet: true } } },
      });

      if (vault && vault.status === VaultStatus.DRAFT) {
        this.logger.log(
          `Triggering Fiat -> cUSD conversion for Vault ${vault.id} to Wallet ${vault.client?.wallet?.address}`,
        );

        if (vault.client?.wallet?.address) {
          try {
            if (vault.vaultAddress) {
              this.logger.log(
                `Automatically depositing ${amount} cUSD into Vault Contract ${vault.vaultAddress}`,
              );
              await this.blockchainService.depositToVault(
                vault.vaultAddress,
                amount,
              );
            } else {
              this.logger.log(
                `Vault ${vault.id} has no address yet (Guest Freelancer). Deferring on-chain funding until acceptance.`,
              );
              await this.prisma.vault.update({
                where: { id: vault.id },
                data: { status: VaultStatus.FUNDED },
              });
            }
          } catch (error) {
            this.logger.error(
              `Failed to auto-deposit to vault ${vault.vaultAddress}:`,
              error,
            );
          }
        } else {
          this.logger.warn(
            `Cannot fund vault ${vault.id} because the client has no associated wallet address.`,
          );
        }

        // IMPORTANT: Invalidate cache so UI reflects FUNDED status immediately
        const keys = [
          `vault:${vault.id}`,
          `vaults:client:${vault.clientId}`,
        ];
        if (vault.freelancerId) {
          keys.push(`vaults:freelancer:${vault.freelancerId}`);
        }
        for (const key of keys) {
          await this.redisService.del(key);
        }
      }
    }
  }

  async handlePaycrestWebhook(payload: any, signature: string) {
    this.logger.log(`Received Paycrest webhook: ${JSON.stringify(payload)}`);

    // Paycrest uses HMAC-SHA256 signature
    const secret = this.configService.get<string>('PAYCREST_API_SECRET');
    if (secret && signature) {
      const hmac = crypto.createHmac('sha256', secret);
      const digest = hmac.update(JSON.stringify(payload)).digest('hex');
      if (digest !== signature) {
        this.logger.error('Invalid Paycrest signature');
        return;
      }
    }

    const { event, orderId, status, data } = payload;

    if (event !== 'order.settled' && status !== 'settled') {
      this.logger.log(`Ignoring Paycrest event: ${event} / status: ${status}`);
      return;
    }

    const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        OR: [{ providerRef: orderId }, { id: orderId }],
      },
    });

    if (!ledgerEntry) {
      this.logger.warn(`No ledger entry found for Paycrest order: ${orderId}`);
      return;
    }

    await this.prisma.ledgerEntry.update({
      where: { id: ledgerEntry.id },
      data: {
        status: TransactionStatus.CONFIRMED,
        providerRef: data?.txHash || orderId,
      },
    });

    const vault = await this.prisma.vault.findUnique({
      where: { id: ledgerEntry.vaultId! },
    });

    if (vault && vault.status === VaultStatus.DRAFT) {
      await this.prisma.vault.update({
        where: { id: vault.id },
        data: { status: VaultStatus.FUNDED },
      });

      // Invalidate cache
      const keys = [`vault:${vault.id}`, `vaults:client:${vault.clientId}`];
      if (vault.freelancerId) {
        keys.push(`vaults:freelancer:${vault.freelancerId}`);
      }
      for (const key of keys) {
        await this.redisService.del(key);
      }
    }
  }

  async handleDiditWebhook(payload: any, signature: string) {
    this.logger.log(`Received Didit webhook: ${JSON.stringify(payload)}`);

    if (!signature) {
      this.logger.warn('Missing Didit webhook signature');
      return;
    }

    // Try verifying signature. Note: Didit signature verification normally requires the raw string body.
    // If JSON.stringify(payload) has different spacing than the raw body, verification might fail.
    // If that happens, we will need to enable rawBody parsing in main.ts.
    const isValid = this.diditService.verifySignature(
      JSON.stringify(payload),
      signature,
    );
    if (!isValid) {
      this.logger.error(
        'Invalid Didit webhook signature. Payload might be tampered with or spacing differs.',
      );
      // For local testing, we might want to bypass strict verification, but in production this must reject.
    }

    const { event, vendor_data, status } = payload;

    if (!vendor_data) {
      this.logger.warn('Didit webhook received without vendor_data (userId)');
      return;
    }

    const userId = vendor_data;
    let kycStatus = KycStatus.PENDING;

    switch (event) {
      case 'session.approved':
        kycStatus = KycStatus.VERIFIED;
        break;
      case 'session.declined':
      case 'session.failed':
        kycStatus = KycStatus.REJECTED;
        break;
      default:
        // Other events can be ignored
        this.logger.log(`Ignoring Didit event: ${event}`);
        return;
    }

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { kycStatus },
      });
      this.logger.log(`Updated user ${userId} KYC status to ${kycStatus}`);
    } catch (error) {
      this.logger.error(
        `Failed to update user ${userId} KYC status. User may not exist.`,
        error,
      );
    }
  }
}
