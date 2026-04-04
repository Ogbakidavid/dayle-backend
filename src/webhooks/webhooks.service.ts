import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
import { NotificationsService } from '../notifications/notifications.service';
import { ethers } from 'ethers';
import { VaultsService } from '../vaults/vaults.service';
import { forwardRef, Inject } from '@nestjs/common';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(forwardRef(() => VaultsService))
    private vaultsService: VaultsService,
    private prisma: PrismaService,
    private configService: ConfigService,
    private blockchainService: BlockchainService,
    private diditService: DiditService,
    private redisService: RedisService,
    private partna: PartnaService,
    private invitesService: InvitesService,
    private mailsService: MailsService,
    private notificationsService: NotificationsService,
  ) {}

  async handlePartnaWebhook(payload: any, signature: string) {
    this.logger.log(`[PARTNA WEBHOOK RECEIVED] ${JSON.stringify(payload)}`);

    const publicKey = this.configService.get<string>('PARTNA_PUBLIC_KEY');

    if (publicKey) {
      if (!signature) {
        this.logger.error('Partna webhook missing signature — rejecting');
        throw new UnauthorizedException('Missing webhook signature');
      }

      try {
        const isValid = crypto.verify(
          'sha256',
          Buffer.from(JSON.stringify(payload.data || payload)),
          {
            key: publicKey.replace(/\\n/g, '\n'),
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          },
          Buffer.from(signature, 'base64'),
        );

        if (!isValid) {
          this.logger.error('Invalid Partna webhook signature — rejecting');
          throw new UnauthorizedException('Invalid webhook signature');
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        this.logger.error(`Signature verification error: ${err.message}`);
        throw new UnauthorizedException(
          'Webhook signature verification failed',
        );
      }
    } else {
      this.logger.warn(
        'PARTNA_PUBLIC_KEY not configured — skipping signature verification',
      );
    }

    const data = payload.data || payload;
    const { reference, rampReference, transactionReference, status, type } = data;
    const ref = rampReference || reference || transactionReference;

    if (!ref) {
      this.logger.warn('Partna webhook missing reference');
      return;
    }

    // Find vault by partnaRampReference or legacy partnaVoucherId
    const vault = await this.prisma.vault.findFirst({
      where: {
        OR: [{ partnaRampReference: ref }, { partnaVoucherId: ref }],
      },
      include: { client: true, freelancer: true },
    });

    const isSuccess = status === 'success' || status === 'completed';
    const isFailed = status === 'failed' || status === 'cancelled';

    if (vault) {
      if (isSuccess) {
        this.logger.log(`Partna ${type} SUCCESS for Vault ${vault.id}`);

        if (type === 'fiatToCrypto' || !type) {
          // ONRAMP SUCCESS
          this.logger.log(
            `[PARTNA ONRAMP WEBHOOK RECEIVED] ref: ${ref} status: ${status}`,
          );
          await this.prisma.$transaction(async (tx) => {
            await tx.vault.update({
              where: { id: vault.id },
              data: { status: VaultStatus.FUNDED },
            });

            await tx.ledgerEntry.updateMany({
              where: { vaultId: vault.id, status: TransactionStatus.PENDING },
              data: { status: TransactionStatus.CONFIRMED },
            });

            // Create LOCK entry for freelancer if assigned
            if (vault.freelancerId) {
              await tx.ledgerEntry.create({
                data: {
                  userId: vault.freelancerId,
                  vaultId: vault.id,
                  type: LedgerEntryType.LOCK,
                  amount: vault.totalAmount,
                  currency: vault.tokenSymbol || "USD",
                  status: TransactionStatus.CONFIRMED,
                  description: `Secured funds for project: ${vault.title}`,
                  completedAt: new Date(),
                },
              });
            }
          });

          // LAND FUNDS IN SMART CONTRACT
          // For Partna (Fiat-to-Crypto), we must bridge the received fiat by depositing
          // from the Treasury/Relayer wallet into the Vault contract.
          if (vault.vaultAddress) {
            try {
              this.logger.log(
                `Automatically depositing ${vault.totalAmount} into Vault Contract ${vault.vaultAddress} following Partna settlement`,
              );

              // Get the deposit ledger entry to attribute the txHash
              const depositEntry = await this.prisma.ledgerEntry.findFirst({
                where: {
                  vaultId: vault.id,
                  type: LedgerEntryType.DEPOSIT,
                  status: TransactionStatus.CONFIRMED,
                },
                orderBy: { createdAt: 'desc' },
              });

              const blockchainTxHash =
                await this.blockchainService.depositToVault(
                  vault.vaultAddress,
                  vault.totalAmount,
                  vault.tokenAddress,
                );

              if (depositEntry) {
                await this.prisma.ledgerEntry.update({
                  where: { id: depositEntry.id },
                  data: { providerRef: blockchainTxHash },
                });
              }

              this.logger.log(
                `Partna-to-Blockchain bridge successful: ${blockchainTxHash}`,
              );
            } catch (error: any) {
              if (error.message?.includes('Vault already funded or invalid state')) {
                this.logger.log(`Partna bridge: Vault ${vault.id} already funded on-chain. Syncing complete.`);
              } else {
                this.logger.error(
                  `Critical: Failed to land funds on-chain for Partna Vault ${vault.id}: ${error.message}`,
                );
              }
            }
          }

          // Trigger on-chain fee collection for the 0.5% deposit processing fee
          if (vault.vaultAddress) {
            try {
              const depositProcessingFee =
                (vault.totalAmount * BigInt(5)) / BigInt(1000);
              this.logger.log(
                `Sweeping 0.5% deposit fee (${depositProcessingFee}) from vault ${vault.vaultAddress}`,
              );
              await this.blockchainService.collectFee(
                vault.vaultAddress,
                depositProcessingFee,
              );
            } catch (error) {
              this.logger.error(
                `Failed to collect deposit fee for vault ${vault.id} on-chain`,
                error,
              );
            }
          }

          await this.invalidateVaultCache(
            vault.id,
            vault.clientId,
            vault.freelancerId,
          );

          await this.notificationsService.createNotification(vault.clientId, {
            type: 'payment',
            title: 'Vault Funded',
            message: `Payment received. Your vault "${vault.title}" is now active.`,
            action: `/client/vault/${vault.id}`,
          });

          const amountFormatted = ethers.formatUnits(
            vault.totalAmount || BigInt(0),
            vault.tokenDecimals || 6,
          );

          // Send Email to Client
          await this.mailsService.sendVaultFundedEmail(
            vault.client.email,
            vault.client.name || 'Client',
            vault.title,
            amountFormatted,
            false,
            vault.localCurrency || undefined,
            vault.localAmount || undefined,
          );

          if (vault.freelancerId) {
            await this.notificationsService.createNotification(
              vault.freelancerId,
              {
                type: 'vault',
                title: 'Funds Locked',
                message: `Funds locked — $${amountFormatted} secured for this project: "${vault.title}".`,
                action: `/freelancer/vault/${vault.id}`,
              },
            );

            // Send Email to Freelancer
            if (vault.freelancer) {
              await this.mailsService.sendVaultFundedEmail(
                vault.freelancer.email,
                vault.freelancer.name || 'Freelancer',
                vault.title,
                amountFormatted,
                true,
                vault.localCurrency || undefined,
                vault.localAmount || undefined,
              );
            }
          }

          await this.handlePostFundingActions(vault.id);
        } else if (type === 'cryptoToFiat') {
          // OFFRAMP SUCCESS
          this.logger.log(
            `[PARTNA OFFRAMP WEBHOOK RECEIVED] ${JSON.stringify(payload)}`,
          );

          await this.prisma.vault.update({
            where: { id: vault.id },
            data: { status: VaultStatus.RELEASED },
          });

          if (vault.freelancerId) {
            const amountFormatted = data.toAmount || data.amount;
            const bankName = vault.partnaBankName || 'bank';

            await this.notificationsService.createNotification(
              vault.freelancerId,
              {
                type: 'payment',
                title: 'Withdrawal Successful',
                message: `Payment sent. ₦${amountFormatted} is on its way to your ${bankName} account.`,
                action: `/freelancer/vault/${vault.id}`,
              },
            );
          }

          // Notify client as well
          await this.notificationsService.createNotification(vault.clientId, {
            type: 'vault',
            title: 'Payment Released',
            message: `Payment has been released to the freelancer.`,
            action: `/client/vault/${vault.id}`,
          });
        }
      } else if (isFailed) {
        this.logger.warn(`Partna ${type} FAILED for Vault ${vault.id}`);
        if (type === 'fiatToCrypto' || !type) {
          await this.prisma.vault.update({
            where: { id: vault.id },
            data: { status: VaultStatus.DRAFT },
          });

          await this.notificationsService.createNotification(vault.clientId, {
            type: 'payment',
            title: 'Payment Failed',
            message: `Your payment for vault "${vault.title}" failed. Please try again.`,
            action: `/client/vault/${vault.id}`,
          });
        } else if (type === 'cryptoToFiat') {
          // OFFRAMP FAILED
          const errorMsg = data.message || 'Provider reported failure';
          this.logger.error(
            `[ADMIN ALERT] Withdrawal failed for vault ${vault.id} — ${errorMsg}`,
          );

          const bankDetails = {
            accountNumber: vault.partnaAccountNumber!,
            bankCode:
              (
                await this.prisma.paymentMethod.findFirst({
                  where: {
                    userId: vault.freelancerId!,
                    accountNumber: vault.partnaAccountNumber!,
                  },
                })
              )?.bankCode || '',
            accountName: vault.partnaAccountName!,
            bankName: vault.partnaBankName!,
          };

          // Notify freelancer
          await this.notificationsService.createNotification(
            vault.freelancerId!,
            {
              type: 'payment',
              title: 'Withdrawal Processing',
              message: `Your withdrawal is being processed. We'll notify you when it's complete.`,
              action: `/freelancer/vault/${vault.id}`,
            },
          );

          try {
            if (bankDetails.bankCode) {
              await this.prisma.vault.update({
                where: { id: vault.id },
                data: { status: VaultStatus.WITHDRAWAL_PENDING },
              });
              await this.vaultsService.scheduleWithdrawalRetry(
                vault.id,
                vault.freelancerId!,
                bankDetails,
                1,
              );
            }
          } catch (e) {
            this.logger.error(
              `Failed to schedule retry after webhook failure: ${e.message}`,
            );
          }
        }
      }
    } else {
      // Logic for non-vault ledger entries (e.g. general withdrawals)
      const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
        where: {
          OR: [{ providerRef: ref }, { id: ref }],
        },
      });

      if (ledgerEntry) {
        const internalStatus = isSuccess
          ? TransactionStatus.CONFIRMED
          : isFailed
            ? TransactionStatus.FAILED
            : TransactionStatus.PENDING;

        await this.prisma.ledgerEntry.update({
          where: { id: ledgerEntry.id },
          data: { status: internalStatus },
        });

        if (isSuccess && type === 'payout') {
          await this.notificationsService.createNotification(
            ledgerEntry.userId,
            {
              type: 'payment',
              title: 'Withdrawal Completed',
              message: `Your withdrawal has been processed successfully.`,
              action: '/settings',
            },
          );
        }
      }
    }
  }

  private async invalidateVaultCache(
    vaultId: string,
    clientId: string,
    freelancerId?: string | null,
  ) {
    const keys = [`vaults:detail:${vaultId}`, `vaults:list:CLIENT:${clientId}`];
    if (freelancerId) keys.push(`vaults:list:FREELANCER:${freelancerId}`);
    await Promise.all(keys.map((k) => this.redisService.del(k)));
  }

  async handlePaycrestWebhook(payload: any, signature: string) {
    this.logger.log(`Received Paycrest webhook: ${JSON.stringify(payload)}`);

    // Paycrest uses HMAC-SHA256 signature
    const secret = this.configService.get<string>('PAYCREST_API_SECRET');
    if (secret) {
      if (!signature) {
        this.logger.error('Paycrest webhook missing signature — rejecting');
        throw new UnauthorizedException('Missing Paycrest signature');
      }

      const hmac = crypto.createHmac('sha256', secret);
      const digest = hmac.update(JSON.stringify(payload)).digest('hex');

      if (digest !== signature) {
        this.logger.error('Invalid Paycrest signature — rejecting');
        throw new UnauthorizedException('Invalid Paycrest signature');
      }
    } else {
      this.logger.warn(
        'PAYCREST_API_SECRET not configured — skipping signature verification',
      );
    }

    const { event, orderId, status, data } = payload;
    this.logger.log(
      `[PAYCREST WEBHOOK RECEIVED] orderId: ${orderId}, event: ${event}, status: ${status}`,
    );

    const isSuccess =
      event === 'order.settled' ||
      status === 'settled' ||
      event === 'payment_order.validated';

    // 1. Check if it's an offramp (withdrawal)
    const offrampVault = await this.prisma.vault.findUnique({
      where: { paycrestOrderId: orderId },
      include: { freelancer: true, client: true },
    });

    if (offrampVault) {
      if (isSuccess && offrampVault.status === VaultStatus.WITHDRAWAL_PENDING) {
        this.logger.log(
          `Paycrest OFFRAMP SUCCESS for Vault ${offrampVault.id}`,
        );
        await this.prisma.vault.update({
          where: { id: offrampVault.id },
          data: { status: VaultStatus.RELEASED },
        });

        // Notify freelancer
        await this.notificationsService.createNotification(
          offrampVault.freelancerId!,
          {
            type: 'payment',
            title: 'Withdrawal Successful',
            message: 'Payment sent. KES arriving in your M-Pesa shortly.',
            action: `/freelancer/vault/${offrampVault.id}`,
          },
        );

        // Notify client
        await this.notificationsService.createNotification(
          offrampVault.clientId,
          {
            type: 'payment',
            title: 'Payment Released',
            message: 'Payment has been released to the freelancer.',
            action: `/client/vault/${offrampVault.id}`,
          },
        );
      }
      return;
    }

    // 2. Otherwise, check if it's an onramp (funding)
    const ledgerEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        OR: [{ providerRef: orderId }, { id: orderId }],
      },
    });

    if (!ledgerEntry) {
      this.logger.warn(
        `No ledger entry or vault found for Paycrest order: ${orderId}`,
      );
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
        this.logger.log(`Triggering Settlement for Paycrest Vault ${vault.id}`);

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
          this.logger.log(
            `Vault ${vault.id} has no address yet (Guest Freelancer). Marking as Funded but without on-chain tx.`,
          );
          depositSuccessful = true;
        }

        if (depositSuccessful) {
          await this.prisma.$transaction(async (tx) => {
            await tx.ledgerEntry.update({
              where: { id: ledgerEntry.id },
              data: {
                status: TransactionStatus.CONFIRMED,
                providerRef: blockchainTxHash,
              },
            });

            // Create LOCK entry for freelancer if assigned
            if (vault.freelancerId) {
              await tx.ledgerEntry.create({
                data: {
                  userId: vault.freelancerId,
                  vaultId: vault.id,
                  type: LedgerEntryType.LOCK,
                  amount: vault.totalAmount,
                  currency: vault.tokenSymbol || "USD",
                  status: TransactionStatus.CONFIRMED,
                  description: `Secured funds for project: ${vault.title}`,
                  completedAt: new Date(),
                },
              });
            }

            // Create negative FEE entry
            const netAmount = vault.totalAmount;
            const grossAmount = BigInt(ledgerEntry.amount);
            const feeAmount = grossAmount - netAmount;

            await tx.ledgerEntry.create({
              data: {
                userId: vault.clientId,
                vaultId: vault.id,
                type: LedgerEntryType.FEE,
                amount: -feeAmount,
                currency: vault.tokenSymbol || 'USD',
                status: TransactionStatus.CONFIRMED,
                description: 'Service fee deducted',
                completedAt: new Date(),
              },
            });

            await tx.vault.update({
              where: { id: vault.id },
              data: {
                status: VaultStatus.FUNDED,
                isFrozen: false,
                frozenReason: null,
              } as any,
            });
          });

          // Invalidate cache
          const keys = [
            `vaults:detail:${vault.id}`,
            `vaults:list:${UserRole.CLIENT}:${vault.clientId}`,
          ];
          if (vault.freelancerId) {
            keys.push(
              `vaults:list:${UserRole.FREELANCER}:${vault.freelancerId}`,
            );
          }
          await Promise.all(keys.map((key) => this.redisService.del(key)));

          this.logger.log(`Paycrest Vault ${vault.id} successfully funded.`);

          // Publish real-time event
          await this.redisService.publish('vault.funded', {
            vaultId: vault.id,
            clientId: vault.clientId,
            freelancerId: vault.freelancerId,
            status: VaultStatus.FUNDED,
          });

          const amountFormatted = ethers.formatUnits(
            vault.totalAmount || BigInt(0),
            vault.tokenDecimals || 6,
          );

          // Send Email to Client
          await this.mailsService.sendVaultFundedEmail(
            vault.client.email,
            vault.client.name || 'Client',
            vault.title,
            amountFormatted,
            false,
            vault.localCurrency || undefined,
            vault.localAmount || undefined,
          );

          if (vault.freelancerId) {
            // Send Email to Freelancer
            const freelancer = await this.prisma.user.findUnique({
              where: { id: vault.freelancerId },
            });
            if (freelancer) {
              await this.mailsService.sendVaultFundedEmail(
                freelancer.email,
                freelancer.name || 'Freelancer',
                vault.title,
                amountFormatted,
                true,
                vault.localCurrency || undefined,
                vault.localAmount || undefined,
              );
            }
          }

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
    const sessionId = payload.session_id;

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
      this.logger.log(
        `Ignoring or internal Didit event: ${event || payload.webhook_type || 'v3_event'}`,
      );
      return;
    }

    // Extract PII (Personal Identifiable Information)
    let fullName = 'Didit Verified User';
    let dob: Date | null = null;
    let idType = 'DIDIT_SESSION';

    // Try to get data from current payload first
    const idVerification = decision?.id_verifications?.[0];
    const amlScreening = decision?.aml_screenings?.[0]?.screened_data;

    if (idVerification?.full_name || amlScreening?.full_name) {
      fullName = idVerification?.full_name || amlScreening?.full_name;
      const dobString =
        idVerification?.date_of_birth || amlScreening?.date_of_birth;
      if (dobString) dob = new Date(dobString);
      if (idVerification?.document_type)
        idType = idVerification.document_type.toUpperCase().replace(' ', '_');
    }

    // CRITICAL: If we are approving, and data is missing in webhook, fetch from API
    if (
      kycStatus === KycStatus.VERIFIED &&
      fullName === 'Didit Verified User' &&
      sessionId
    ) {
      this.logger.log(
        `Fetching full session data for ${sessionId} to get missing PII`,
      );
      const fullSession = await this.diditService.getSession(sessionId);
      if (fullSession?.decision) {
        const fullIv = fullSession.decision.id_verifications?.[0];
        const fullAml = fullSession.decision.aml_screenings?.[0]?.screened_data;
        if (fullIv?.full_name || fullAml?.full_name) {
          fullName = fullIv?.full_name || fullAml?.full_name;
          const dobString = fullIv?.date_of_birth || fullAml?.date_of_birth;
          if (dobString) dob = new Date(dobString);
          if (fullIv?.document_type)
            idType = fullIv.document_type.toUpperCase().replace(' ', '_');
          this.logger.log(`Successfully recovered PII from API: ${fullName}`);
        }
      }
    }

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          kycStatus,
          ...(kycStatus === KycStatus.VERIFIED && {
            name: fullName, // Update user's name to match verified ID
            kycData: {
              upsert: {
                create: {
                  fullName: fullName,
                  dateOfBirth: dob || new Date(0),
                  address: 'Verified via Didit Protocol',
                  idDocumentUrl: 'didit://verified',
                  idType: idType,
                },
                update: {
                  fullName: fullName,
                  dateOfBirth: dob || new Date(0),
                  reviewedAt: new Date(),
                },
              },
            },
          }),
        },
      });
      this.logger.log(`Updated user ${userId} KYC status to ${kycStatus}`);

      // Send in-app notification for VERIFIED or REJECTED
      if (
        kycStatus === KycStatus.VERIFIED ||
        kycStatus === KycStatus.REJECTED
      ) {
        // Deduplicate: Don't create if an unread notification of the same type already exists
        const existingNotif = await this.prisma.notification.findFirst({
          where: {
            userId,
            type: 'kyc',
            title:
              kycStatus === KycStatus.VERIFIED
                ? 'Identity Verified'
                : 'Identity Verification Rejected',
          },
        });

        if (!existingNotif) {
          await this.notificationsService.createNotification(userId, {
            type: 'kyc',
            title:
              kycStatus === KycStatus.VERIFIED
                ? 'Identity Verified'
                : 'Identity Verification Rejected',
            message:
              kycStatus === KycStatus.VERIFIED
                ? 'Congratulations! Your identity has been successfully verified. You now have full access to all features.'
                : 'Your identity verification was rejected. Please check your email for details or contact support.',
            action:
              kycStatus === KycStatus.REJECTED ? '/onboarding/kyc' : undefined,
          });
        }
      }

      if (isResubmitted) {
        await this.prisma.notification.create({
          data: {
            userId: userId,
            type: 'kyc',
            title: 'KYC Resubmission Needed',
            message:
              'Your identity verification requires you to resubmit or retake photos. Please try again.',
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
      include: { client: true },
    });

    if (!vault) return;

    // Check if there's a pending invite for this vault
    const invite = await this.prisma.invite.findFirst({
      where: { vaultId: vault.id, status: InviteStatus.PENDING },
    });

    if (invite) {
      try {
        this.logger.log(
          `Vault funded. Sending invitation email to guest freelancer ${invite.email}...`,
        );
        const amount = Number(
          ethers.formatUnits(
            vault.totalAmount || BigInt(0),
            vault.tokenDecimals || 6,
          ),
        );

        await this.mailsService.sendInviteEmail(
          invite.email,
          vault.client?.name || 'A client',
          vault.title,
          amount,
          invite.token,
          vault.localCurrency || undefined,
          vault.localAmount || undefined,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send post-funding invite to ${invite.email}`,
          error,
        );
      }
    }
  }
}
