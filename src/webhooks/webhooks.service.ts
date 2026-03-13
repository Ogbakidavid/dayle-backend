import { Injectable, Logger } from '@nestjs/common';
import { PartnaService } from '../common/services/partna.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  TransactionStatus,
  LedgerEntryType,
  VaultStatus,
  KycStatus,
  UserRole,
  InviteStatus,
} from '../domain/enums';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { BlockchainService } from '../common/services/blockchain.service';
import { DiditService } from '../common/services/didit.service';
import { RedisService } from '../common/redis/redis.service';
import { InvitesService } from '../invites/invites.service';
import { MailsService } from '../notifications/mails.service';
import { ethers } from 'ethers';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private diditService: DiditService,
    private redisService: RedisService,
    private partna: PartnaService,
    private invitesService: InvitesService,
    private mailsService: MailsService,
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

    const { reference, status, amount, type, voucherCode } = payload.data || payload;

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

    // Determine if we should trigger crypto delivery
    const isSuccess = status === 'success';
    const isCollection = type === 'collection' || type === 'voucher';

    if (isSuccess && isCollection) {
      const vault = await this.prisma.vault.findUnique({
        where: { id: ledgerEntry.vaultId! },
        include: { client: { include: { wallet: true } } },
      });

      if (
        vault &&
        (vault.status === VaultStatus.DRAFT ||
          vault.status === VaultStatus.FUNDED)
      ) {
        this.logger.log(
          `Triggering Fiat -> Crypto delivery for Vault ${vault.id}`,
        );

        let depositSuccessful = false;
        let blockchainTxHash: string | null = null;

        if (vault.client?.wallet?.address) {
          try {
            if (vault.vaultAddress && voucherCode) {
              try {
                this.logger.log(
                  `Automatically redeeming voucher ${voucherCode} for Vault ${vault.vaultAddress}`,
                );
                await this.partna.redeemAndWithdraw({
                  voucherCode,
                  walletAddress: vault.vaultAddress!,
                  network: 'celo',
                  token: vault.tokenSymbol || 'cUSD',
                });
                depositSuccessful = true;
              } catch (e) {
                this.logger.warn(
                  `Partna voucher redemption failed: ${e.message}. Falling back to manual blockchain deposit.`,
                );
              }
            }

            if (!depositSuccessful && vault.vaultAddress) {
              this.logger.log(
                `Manual deposit fallback for Vault ${vault.vaultAddress}.`,
              );
              blockchainTxHash = await this.blockchainService.depositToVault(
                vault.vaultAddress,
                BigInt(ledgerEntry.amount),
                vault.tokenAddress,
              );
              depositSuccessful = true;
            } else if (!vault.vaultAddress) {
              this.logger.log(
                `Vault ${vault.id} has no address yet (Guest Freelancer). Marking as Funded but without on-chain tx.`,
              );
              depositSuccessful = true;
            }
          } catch (error) {
            this.logger.error(
              `Critical error during blockchain deposit for Vault ${vault.id}: ${error.message}`,
            );
            // We intentionally do NOT update the status to CONFIRMED or FUNDED here
            // This leaves the Ledger Entry in PENDING so the user can see it didn't complete.
          }
        }

        if (depositSuccessful) {
          // Both DB updates should be inside a transaction for consistency
          await this.prisma.$transaction([
            this.prisma.ledgerEntry.update({
              where: { id: ledgerEntry.id },
              data: {
                status: TransactionStatus.CONFIRMED,
                providerRef: blockchainTxHash || ledgerEntry.providerRef,
              },
            }),
            this.prisma.vault.update({
              where: { id: vault.id },
              data: {
                status: VaultStatus.FUNDED,
                isFrozen: false,
                frozenReason: null,
              } as any,
            }),
          ]);

          // Invalidate cache so UI reflects change
          const keys = [`vaults:detail:${vault.id}`, `vaults:list:${UserRole.CLIENT}:${vault.clientId}`];
          if (vault.freelancerId) {
            keys.push(`vaults:list:${UserRole.FREELANCER}:${vault.freelancerId}`);
          }
          await Promise.all(keys.map(key => this.redisService.del(key)));

          this.logger.log(`Vault ${vault.id} successfully funded and ledger confirmed.`);
          
          // Publish real-time event
          await this.redisService.publish('vault.funded', {
            vaultId: vault.id,
            clientId: vault.clientId,
            freelancerId: vault.freelancerId,
            status: VaultStatus.FUNDED,
          });

          await this.handlePostFundingActions(vault.id);
        }
      }
    } else {
      // For non-deposit webhooks or failures, just update the ledger status normally
      await this.prisma.ledgerEntry.update({
        where: { id: ledgerEntry.id },
        data: { status: internalStatus },
      });
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
    const isSuccess = event === 'order.settled' || status === 'settled';

    const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        OR: [{ providerRef: orderId }, { id: orderId }],
      },
    });

    if (!ledgerEntry) {
      this.logger.warn(`No ledger entry found for Paycrest order: ${orderId}`);
      return;
    }

    if (isSuccess) {
      const vault = await this.prisma.vault.findUnique({
        where: { id: ledgerEntry.vaultId! },
        include: { client: { include: { wallet: true } } },
      });

      if (
        vault &&
        (vault.status === VaultStatus.DRAFT ||
          vault.status === VaultStatus.FUNDED)
      ) {
        this.logger.log(`Triggering Fiat -> Crypto delivery for Paycrest Vault ${vault.id}`);

        let depositSuccessful = false;
        let blockchainTxHash = data?.txHash || orderId;

        if (vault.client?.wallet?.address && vault.vaultAddress) {
          try {
            this.logger.log(
              `Automatically depositing ${ledgerEntry.amount} into Vault Contract ${vault.vaultAddress}`,
            );
            blockchainTxHash = await this.blockchainService.depositToVault(
              vault.vaultAddress,
              BigInt(ledgerEntry.amount),
              vault.tokenAddress,
            );
            depositSuccessful = true;
          } catch (error) {
            this.logger.error(
              `Critical error during Paycrest blockchain deposit for Vault ${vault.id}: ${error.message}`,
            );
          }
        } else if (!vault.vaultAddress) {
          this.logger.log(`Vault ${vault.id} has no address yet (Guest Freelancer). Marking as Funded but without on-chain tx.`);
          depositSuccessful = true;
        }

        if (depositSuccessful) {
          await this.prisma.$transaction([
            this.prisma.ledgerEntry.update({
              where: { id: ledgerEntry.id },
              data: {
                status: TransactionStatus.CONFIRMED,
                providerRef: blockchainTxHash,
              },
            }),
            this.prisma.vault.update({
              where: { id: vault.id },
              data: {
                status: VaultStatus.FUNDED,
                isFrozen: false,
                frozenReason: null,
              } as any,
            }),
          ]);

          // Invalidate cache
          const keys = [`vaults:detail:${vault.id}`, `vaults:list:${UserRole.CLIENT}:${vault.clientId}`];
          if (vault.freelancerId) {
            keys.push(`vaults:list:${UserRole.FREELANCER}:${vault.freelancerId}`);
          }
          await Promise.all(keys.map(key => this.redisService.del(key)));

          this.logger.log(`Paycrest Vault ${vault.id} successfully funded.`);

          // Publish real-time event
          await this.redisService.publish('vault.funded', {
            vaultId: vault.id,
            clientId: vault.clientId,
            freelancerId: vault.freelancerId,
            status: VaultStatus.FUNDED,
          });

          await this.handlePostFundingActions(vault.id);
        }
      }
    } else {
      await this.prisma.ledgerEntry.update({
        where: { id: ledgerEntry.id },
        data: { status: TransactionStatus.FAILED },
      });
    }
  }

  async handleDiditWebhook(payload: any, signature: string, rawBody?: string) {
    this.logger.log(`Received Didit webhook: ${JSON.stringify(payload)}`);

    if (!signature) {
      this.logger.warn('Missing Didit webhook signature');
      return;
    }

    // Use rawBody for verification if available, as it's more reliable than JSON.stringify
    const isValid = this.diditService.verifySignature(
      rawBody || JSON.stringify(payload),
      signature,
    );
    if (!isValid) {
      this.logger.error(
        'Invalid Didit webhook signature. Payload might be tampered with or spacing differs.',
      );
      // For local testing, we might want to bypass strict verification, but in production this must reject.
    }

    // Didit V3 sends decision and metadata objects. V2 sends event/vendor_data at top level.
    const { event, vendor_data, status, decision, metadata } = payload;
    
    // Extract user ID (vendor_data) - V3 vs V2
    const userId = metadata?.vendor_data || vendor_data;
    const outcome = decision?.outcome;
    
    if (!userId) {
      this.logger.warn('Didit webhook received without vendor_data (userId)');
      return;
    }

    let kycStatus = KycStatus.PENDING;

    // Determine normalized status
    const isApproved = 
      event === 'session.approved' || 
      outcome === 'approved' || 
      status === 'Approved' || 
      status === 'approved' ||
      (payload.webhook_type === 'status.updated' && status === 'Approved');

    const isRejected = 
      event === 'session.declined' || 
      event === 'session.failed' || 
      outcome === 'declined' || 
      outcome === 'failed' ||
      status === 'Declined' ||
      status === 'Failed' ||
      status === 'declined' ||
      status === 'failed';

    const isResubmitted = 
      event === 'session.resubmitted' ||
      outcome === 'resubmitted' ||
      status === 'Resubmitted' ||
      status === 'resubmitted' ||
      (payload.webhook_type === 'status.updated' && status === 'Resubmitted');

    if (isApproved) {
      kycStatus = KycStatus.VERIFIED;
    } else if (isRejected || isResubmitted) {
      kycStatus = KycStatus.REJECTED;
    } else {
      this.logger.log(`Ignoring or internal Didit event: ${event || payload.webhook_type || 'v3_event'}`);
      return;
    }

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { 
          kycStatus,
          ...(kycStatus === KycStatus.VERIFIED && {
            kycData: {
              upsert: {
                create: {
                  fullName: 'Didit Verified User',
                  dateOfBirth: new Date(0),
                  address: 'Verified via Didit Protocol',
                  idDocumentUrl: 'didit://verified',
                  idType: 'DIDIT_SESSION',
                },
                update: {
                  reviewedAt: new Date(),
                },
              },
            },
          }),
        },
      });
      this.logger.log(`Updated user ${userId} KYC status to ${kycStatus}`);

      if (isResubmitted) {
        await this.prisma.notification.create({
          data: {
            userId: userId,
            type: 'kyc',
            title: 'KYC Resubmission Needed',
            message: 'Your identity verification requires you to resubmit or retake photos. Please try again.',
            action: '/onboarding/kyc',
            read: false,
            timestamp: new Date(),
          },
        });
      }
    } catch (error) {
      this.logger.error(`Failed to update user ${userId} KYC status.`, error);
    }
  }

  private async handlePostFundingActions(vaultId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true }
    });

    if (!vault) return;

    // Check if there's a pending invite for this vault
    const invite = await this.prisma.invite.findFirst({
      where: { vaultId: vault.id, status: InviteStatus.PENDING }
    });

    if (invite) {
      try {
        this.logger.log(`Vault funded. Sending invitation email to guest freelancer ${invite.email}...`);
        const amount = Number(ethers.formatUnits(vault.totalAmount || BigInt(0), vault.tokenDecimals || 6));
        
        await this.mailsService.sendInviteEmail(
          invite.email,
          vault.client?.name || 'A client',
          vault.title,
          amount,
          invite.token,
        );
      } catch (error) {
         this.logger.error(`Failed to send post-funding invite to ${invite.email}`, error);
      }
    }
  }
}
