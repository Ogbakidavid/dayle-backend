import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVaultDto } from './dto/create-vault.dto';
import { ReleaseVaultDto } from './dto/release-vault.dto';
import { RefundVaultDto } from './dto/refund-vault.dto';
import { FundVaultDto } from './dto/fund-vault.dto';
import { UpdateVaultStatusDto } from './dto/update-vault-status.dto';
import { SubmitVaultDto } from './dto/submit-vault.dto';
import { PaymentRouter } from '../common/services/payment-router.service';
import {
  VaultStatus,
  UserRole,
  LedgerEntryType,
  TransactionStatus,
  InviteStatus,
} from '../domain/enums';
import { KycStatus } from '../domain/enums';
import * as crypto from 'crypto';
import { RedisService } from '../common/redis/redis.service';
import { Prisma } from '@prisma/client';
import { ethers } from 'ethers';

import { BlockchainService } from '../common/services/blockchain.service';
import { InvitesService } from '../invites/invites.service';
import { MailsService } from '../notifications/mails.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RatesService } from '../rates/rates.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { calculateDayleFee } from '../common/utils/fee.utils';

import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VaultsService {
  private readonly logger = new Logger(VaultsService.name);
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private paymentRouter: PaymentRouter,
    private blockchainService: BlockchainService,
    private invitesService: InvitesService,
    private mailsService: MailsService,
    private notificationsService: NotificationsService,
    @Inject(forwardRef(() => RatesService))
    private ratesService: RatesService,
    @Inject(forwardRef(() => PartnaService))
    private partnaService: PartnaService,
    private paycrestService: PaycrestService,
    private configService: ConfigService,
    @Optional()
    @InjectQueue('vault-withdrawal')
    private withdrawalQueue: Queue,
    @Optional()
    @InjectQueue('vault-release')
    private vaultReleaseQueue: Queue,
    @Optional()
    @InjectQueue('vault-refund')
    private vaultRefundQueue: Queue,
  ) {}

  async create(dto: CreateVaultDto, userId: string, role: string) {
    const prisma = this.prisma;

    if (dto.idempotencyKey) {
      const cachedResponse = await this.redis.get(
        `idempotency:${dto.idempotencyKey}`,
      );
      if (cachedResponse) {
        return JSON.parse(cachedResponse);
      }
    }

    // 1. Fetch Client info
    const client = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    const clientAddress = client?.wallet?.address;

    if (!clientAddress) {
      throw new BadRequestException('Client does not have a connected wallet.');
    }

    if (!client.paymentAccountReady) {
      throw new BadRequestException(
        'KYC Tier 1 (BVN/Phone) must be completed before you can create vaults.',
      );
    }

    // 2. Resolve Freelancer info
    let freelancerId: string | null = null;
    let freelancerAddress: string =
      '0x0000000000000000000000000000000000000000';

    if (dto.freelancerEmail) {
      const freelancer = await this.prisma.user.findUnique({
        where: { email: dto.freelancerEmail },
        include: { wallet: true },
      });

      if (freelancer) {
        freelancerId = freelancer.id;
        freelancerAddress = freelancer.wallet?.address || freelancerAddress;
      }
    }

    // 3. Deploy the Web3 Vault using the master relayer (Arbiter/Treasury)
    // Always deploy, even for guest freelancers (use Arbiter as placeholder)
    let deployedVaultAddress: string | null = null;
    const finalFreelancerAddress =
      freelancerAddress === '0x0000000000000000000000000000000000000000'
        ? this.configService.get<string>('ARBITER_ADDRESS')!
        : freelancerAddress;

    // Convert totalAmount to BigInt (smallest units)
    // Use toFixed to avoid "too many decimals" errors from floating point precision
    const sanitizedAmount = dto.totalAmount.toFixed(dto.tokenDecimals);
    const budgetWei = ethers.parseUnits(sanitizedAmount, dto.tokenDecimals);
    // Budget is what the freelancer gets (net)
    const budgetBigInt = budgetWei;

    // Vault total amount is the gross amount the client funds
    const totalAmountBigInt = budgetWei;
    const finalAmountString = ethers.formatUnits(
      totalAmountBigInt,
      dto.tokenDecimals,
    );

    this.logger.log(
      `Deploying vault for client ${clientAddress} and freelancer ${finalFreelancerAddress}. Total Amount: ${finalAmountString}`,
    );
    const { vaultAddress } = await this.blockchainService.deployVault(
      clientAddress,
      finalFreelancerAddress,
      finalAmountString, // deployVault takes string amount
      dto.tokenAddress,
    );
    deployedVaultAddress = vaultAddress;

    // Calculate fees to store in DB
    const fees = calculateDayleFee(dto.totalAmount);

    const vault = await this.prisma.vault.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type as any,
        totalAmount: budgetBigInt, // Store gross budget
        amount: budgetBigInt, // Also store as amount initially
        tokenAddress: dto.tokenAddress,
        tokenSymbol: dto.tokenSymbol || null,
        tokenDecimals: dto.tokenDecimals,
        chainId: dto.chainId,
        clientId: userId,
        freelancerId: null, // Always start as null; linked only upon invitation acceptance
        status: VaultStatus.DRAFT, // Always start as DRAFT
        vaultAddress: deployedVaultAddress || null,
        deliverables: {
          create: (dto.deliverables || []).map((d) => ({
            title: d.title,
            description: d.description,
            submissionType: d.submissionType || 'FILE',
          })),
        },
        localCurrency: dto.localCurrency || 'USD',
        localAmount: dto.localAmount || null,
        localSettlementFee: dto.localAmount
          ? Number(
              (
                (dto.localAmount / 1.005) *
                (fees.settlementFeePercent / 100)
              ).toFixed(2),
            )
          : null,
        localProcessingFee: dto.localAmount
          ? Number((dto.localAmount - dto.localAmount / 1.005).toFixed(2))
          : null,
        localFreelancerReceives: dto.localAmount
          ? Number(
              (
                (dto.localAmount / 1.005) *
                ((100 - fees.settlementFeePercent) / 100)
              ).toFixed(2),
            )
          : null,
        settlementFeeUSD: fees.settlementFeeUSD,
        processingFeeUSD: fees.processingFeeUSD,
        totalFeeUSD: fees.totalFeeUSD,
        freelancerReceivesUSD: fees.freelancerReceivesUSD,
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
        deliverables: true,
      },
    });

    // 4. Create a pending invite for the freelancer (always required for acceptance flow)
    if (dto.freelancerEmail) {
      try {
        this.logger.log(
          `Creating pending invitation for ${dto.freelancerEmail}...`,
        );
        const invite = await this.invitesService.create(
          {
            vaultId: vault.id,
            email: dto.freelancerEmail,
            expiresInDays: 7,
          },
          userId,
        );

        // Send invitation email immediately
        await this.mailsService.sendInviteEmail(
          dto.freelancerEmail,
          vault.client?.name || 'A client',
          vault.title,
          dto.totalAmount,
          invite.token,
          dto.localCurrency || undefined,
          dto.localAmount || undefined,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create pending invite for guest freelancer ${dto.freelancerEmail}`,
          error,
        );
      }
    }
    if (dto.idempotencyKey) {
      const response = this.formatVault(vault);
      await this.redis.set(
        `idempotency:${dto.idempotencyKey}`,
        JSON.stringify(response),
        24 * 60 * 60, // 24 hours
      );
    }

    await this.invalidateVaultCache(vault.id, userId, vault.freelancerId);
    return this.formatVault(vault);
  }

  private async invalidateVaultCache(
    vaultId: string,
    clientId: string,
    freelancerId?: string | null,
  ) {
    const keys = [
      `vaults:detail:${vaultId}`,
      `vaults:list:${UserRole.CLIENT}:${clientId}`,
    ];
    if (freelancerId) {
      keys.push(`vaults:list:${UserRole.FREELANCER}:${freelancerId}`);
    }
    await Promise.all(keys.map((key) => this.redis.del(key)));
  }

  async list(userId: string, role: UserRole) {
    this.logger.log(`Listing vaults for user ${userId} with role ${role}`);
    const prisma = this.prisma;
    const cacheKey = `vaults:list:${role}:${userId}`;
    this.logger.log(`Checking cache for key: ${cacheKey}`);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.log(`Cache hit for key: ${cacheKey}`);
      return JSON.parse(cached);
    }
    this.logger.log(`Cache miss for key: ${cacheKey}. Querying DB...`);

    const where =
      role === UserRole.CLIENT
        ? { clientId: userId }
        : { freelancerId: userId };

    this.logger.log(`Query where clause: ${JSON.stringify(where)}`);

    const vaults = await this.prisma.vault.findMany({
      where,
      include: {
        submissions: {
          orderBy: { submittedAt: 'desc' },
        },
        deliverables: true,
        ledgerEntries: true,
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = {
      vaults: vaults.map((v) => this.formatVault(v)),
      total: vaults.length,
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 3600); // 1 hour TTL
    return result;
  }

  async getStatus(id: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: id },
      select: { status: true },
    });
    if (!vault) throw new NotFoundException('Vault not found');
    return vault;
  }

  async getById(id: string, userId: string, role: string) {
    const prisma = this.prisma;
    const cacheKey = `vaults:detail:${id}`;
    const cached = await this.redis.get(cacheKey);
    let vaultResult: any;

    if (cached) {
      vaultResult = JSON.parse(cached);
    } else {
      const vault = await this.prisma.vault.findUnique({
        where: { id },
        include: {
          submissions: {
            orderBy: { submittedAt: 'desc' },
          },
          deliverables: true,
          ledgerEntries: true,
          client: { select: { id: true, name: true, email: true } },
          freelancer: { select: { id: true, name: true, email: true } },
        },
      });

      if (!vault) {
        throw new NotFoundException({
          code: 'VAULT_NOT_FOUND',
          message: 'Vault not found',
        });
      }

      vaultResult = this.formatVault(vault);
      await this.redis.set(cacheKey, JSON.stringify(vaultResult), 3600); // 1 hour TTL
    }

    if (
      vaultResult.clientId !== userId &&
      vaultResult.freelancerId !== userId
    ) {
      this.logger.warn(
        `Access denied for vault ${id}: user ${userId} is neither client ${vaultResult.clientId} nor freelancer ${vaultResult.freelancerId}`,
      );
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }

    return vaultResult;
  }

  async fund(id: string, dto: FundVaultDto, userId: string, role: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id },
      include: { client: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException('Not authorized');

    if (vault.client.kycStatus !== KycStatus.VERIFIED && this.configService.get('TESTNET_MODE') !== 'true') {
      throw new BadRequestException(
        'KYC verification must be completed before funding.',
      );
    }

    // Calculate Gross Amount (Budget + 0.5% processing fee)
    const budgetUSD = parseFloat(
      ethers.formatUnits(
        vault.totalAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
    );
    const grossUSD = budgetUSD * 1.005;

    const result = await this.paymentRouter.initiateOnramp({
      amount: grossUSD,
      currency: dto.currency || 'USD',
      reference: `vault_fund_${id}`,
      customerEmail: vault.client.email,
      customerFullName: vault.client.name,
      country: vault.client.country || 'NGA',
      vaultId: id,
    });

    // Create a pending ledger entry for the client
    const providerRef = result.providerRef || `vault_fund_${id}`;
    const existingEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        vaultId: vault.id,
        userId,
        status: TransactionStatus.PENDING,
        type: LedgerEntryType.DEPOSIT,
      },
    });

    if (existingEntry) {
      await this.prisma.ledgerEntry.update({
        where: { id: existingEntry.id },
        data: {
          providerRef: providerRef,
          amount: vault.totalAmount, // This is the net budget being locked
          createdAt: new Date(),
        },
      });
    } else {
      await this.prisma.ledgerEntry.create({
        data: {
          userId,
          vaultId: vault.id,
          type: LedgerEntryType.DEPOSIT,
          amount: vault.totalAmount,
          currency: 'USD',
          status: TransactionStatus.PENDING,
          description: `Funding vault: ${vault.title}`,
          providerRef: providerRef,
        },
      });
    }

    return result;
  }

  async initiatePartnaFunding(
    vaultId: string,
    userId: string,
    dto: FundVaultDto,
  ): Promise<any> {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException('Not authorized');

    if (!vault.client.paymentAccountReady) {
      throw new BadRequestException(
        'Payment account setup (BVN/Phone) must be completed before funding.',
      );
    }

    if (
      vault.status === VaultStatus.AWAITING_PAYMENT &&
      vault.partnaAccountNumber
    ) {
      this.logger.log(
        `[VAULT FUND] Returning existing bank details for vault:${vaultId}`,
      );
      return {
        bankDetails: {
          accountNumber: vault.partnaAccountNumber,
          accountName: vault.partnaAccountName,
          bankName: vault.partnaBankName || 'Standard Chartered',
          amount: vault.partnaFromAmount || vault.localAmount,
          currency: vault.partnaFromCurrency || vault.localCurrency,
          reference: vault.partnaRampReference,
          expiresAt: vault.partnaExpiryDate
            ? vault.partnaExpiryDate.toISOString()
            : new Date().toISOString(),
        },
      };
    }

    // Calculate tiered fees based on Budget
    const budgetUSD = parseFloat(
      ethers.formatUnits(
        vault.totalAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
    );
    const grossUSD = budgetUSD * 1.005;
    const fees = calculateDayleFee(budgetUSD);

    // Fetch live rate or use provided one
    const currency =
      dto.currency || (vault.client.country === 'Kenya' ? 'KES' : 'NGN');
    let rate: number;
    let rateKey: string;

    // For simplicity and correctness, we re-fetch/verify the rate
    const rateResult = await this.ratesService.getTransactionRate(
      currency,
      grossUSD,
      vaultId,
      'funding',
    );
    rate = rateResult.rate;
    rateKey = rateResult.rateKey!;

    // Determine local amount: prioritize stored localAmount from creation for consistency
    let localAmount = dto.amount;
    if (!localAmount && vault.localAmount && vault.localCurrency === currency) {
      localAmount = Math.round(Number(vault.localAmount));
      this.logger.log(
        `[VAULT FUND] Using stored localAmount for consistency: ${localAmount} ${currency}`,
      );
    } else if (!localAmount) {
      localAmount = Math.round(grossUSD / rate);
      this.logger.log(
        `[VAULT FUND] Calculated new localAmount: ${localAmount} ${currency}`,
      );
    }

    // IMPORTANT: Always generate a fresh reference if we are creating a new ramp
    // Reusing vault.partnaRampReference causes "ramp reference already exists" errors if the previous attempt was interrupted.
    let rampReference = crypto.randomBytes(16).toString('hex');
    while (rampReference.startsWith('0')) {
      rampReference = crypto.randomBytes(16).toString('hex');
    }
    const network = currency === 'KES' ? 'kenyanshilling' : 'naira';

    // Partna requires the registered partnaCustomerId for the accountName field
    // Fallback to name-based sanitization if ID is missing (though it should be present for paymentAccountReady users)
    const partnaAccountName = (
      vault.client.partnaCustomerId || vault.client.name
    )
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();

    let phoneID = currency === 'KES' ? vault.client.partnaAccountRef : undefined;

    // IF KES and phoneID looks like a placeholder (e.g. from old version), try to recover it
    if (currency === 'KES' && (!phoneID || phoneID.startsWith('REF-'))) {
      this.logger.log(
        `[VAULT FUND] Attempting to recover phoneID for Kenyan user: ${partnaAccountName}...`,
      );
      try {
        const verifiedPhoneRes: any = await this.partnaService.getVerifiedPhone(
          'KE',
          partnaAccountName,
        );
        // Partna v4 /phone returns { data: { validPhoneRecords: [{ phoneID, ... }] } }
        const recoveredPhone = verifiedPhoneRes?.data?.validPhoneRecords?.[0];
        if (recoveredPhone?.phoneID) {
          phoneID = recoveredPhone.phoneID;
          this.logger.log(
            `[VAULT FUND] Successfully recovered phoneID: ${phoneID}. Updating user...`,
          );
          await this.prisma.user.update({
            where: { id: vault.client.id },
            data: { partnaAccountRef: phoneID },
          });
        }
      } catch (e: any) {
        this.logger.warn(
          `[VAULT FUND] Failed to recover phoneID for Kenya: ${e.message}`,
        );
      }
    }

    this.logger.log(
      `[VAULT FUND] Initiating Partna ramp: Ref:${rampReference}, PhoneID:${phoneID || 'none'}, Amount:${localAmount} ${currency}`,
    );

    const rampResponse: any = await this.partnaService.createRamp({
      type: 'fiatToCrypto',
      fromCurrency: currency,
      fromNetwork: network,
      toCurrency: 'USDC',
      toNetwork: 'celo',
      fromAmount: localAmount,
      cryptoAddress:
        vault.vaultAddress ||
        this.configService.get<string>('VAULT_FACTORY_ADDRESS'),
      rateKey: rateKey,
      rampReference: rampReference,
      accountName: partnaAccountName,
      phoneID: phoneID,
      cancelPendingRampRequest: true, // Allow re-generating bank details if one is already pending
    });

    const rampData: any = rampResponse?.data ?? {};
    const resolvedAccountName =
      typeof rampData.accountName === 'string' ? rampData.accountName : '';
    const normalizedResolvedName = resolvedAccountName
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
    const expiryTimestamp =
      typeof rampData.expiryDate === 'number' ? rampData.expiryDate : 0;
    const fromAmount =
      typeof rampData.fromAmount === 'number' ? rampData.fromAmount : null;
    const toAmount =
      typeof rampData.toAmount === 'number' ? rampData.toAmount : null;

    // Store ramp details in vault
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: {
        status: VaultStatus.AWAITING_PAYMENT,
        partnaAccountName:
          (normalizedResolvedName === 'testmanagedaccount'
            ? vault.client.name
            : resolvedAccountName
          )
            ?.replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase() || null,
        partnaAccountNumber:
          (typeof rampData.accountNumber === 'string'
            ? rampData.accountNumber
            : null) || (typeof rampData.kesShortcode === 'string' ? rampData.kesShortcode : null),
        partnaBankName:
          (typeof rampData.bankName === 'string' ? rampData.bankName : null) || (currency === 'KES' ? 'M-Pesa / Mobile Money' : null),
        partnaExpiryDate: new Date(expiryTimestamp * 1000),
        partnaExpectedAmount: toAmount,
        partnaFromAmount: fromAmount,
        partnaFromCurrency: currency,
        partnaRampReference: rampReference,
        partnaRateKey: rateKey,
        localAmount: fromAmount,
      },
    });

    // Handle Ledger Entry for Visibility
    const existingEntry = await this.prisma.ledgerEntry.findFirst({
      where: {
        vaultId: vault.id,
        userId,
        status: 'PENDING' as any,
        type: 'DEPOSIT' as any,
      },
    });

    if (existingEntry) {
      await this.prisma.ledgerEntry.update({
        where: { id: existingEntry.id },
        data: {
          providerRef: rampReference,
          amount: vault.totalAmount, // Ensure amount is up to date
          createdAt: new Date(), // Refresh the timestamp
        },
      });
    } else {
      await this.prisma.ledgerEntry.create({
        data: {
          userId,
          vaultId: vault.id,
          type: 'DEPOSIT' as any,
          amount: vault.totalAmount,
          currency: 'USD',
          status: 'PENDING' as any,
          description: `Funding vault: ${vault.title}`,
          providerRef: rampReference,
        },
      });
    }

    return {
      bankDetails: {
        bankName: (typeof rampData.bankName === 'string' ? rampData.bankName : null) || (currency === 'KES' ? 'M-Pesa / Mobile Money' : null),
        accountNumber: (typeof rampData.accountNumber === 'string' ? rampData.accountNumber : null) || (typeof rampData.kesShortcode === 'string' ? rampData.kesShortcode : null),
        accountName: resolvedAccountName || partnaAccountName,
        amount: fromAmount,
        currency: currency,
        reference: rampReference,
        expiresAt: new Date(expiryTimestamp * 1000).toISOString(),
      },
      partnaFee: rampData.feeInFromCurrency,
    };
  }

  async initiateWithdrawal(
    vaultId: string,
    userId: string,
    bankDetails: {
      accountNumber: string;
      bankCode: string;
      accountName: string;
      bankName?: string;
    },
    retryCount: number = 0,
  ): Promise<any> {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { freelancer: { include: { wallet: true } } },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.freelancerId !== userId)
      throw new ForbiddenException('Not authorized');

    if (
      (vault.freelancer?.kycStatus !== KycStatus.VERIFIED && this.configService.get('TESTNET_MODE') !== 'true') ||
      !vault.freelancer?.paymentAccountReady
    ) {
      throw new BadRequestException(
        'KYC verification and payment account setup must be completed before withdrawal.',
      );
    }

    if (
      vault.status !== VaultStatus.RELEASED &&
      vault.status !== VaultStatus.WITHDRAWAL_PENDING
    ) {
      throw new BadRequestException('Funds have not been released yet');
    }

    // Immediately mark as pending and return to client
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: { status: VaultStatus.WITHDRAWAL_PENDING },
    });

    // Queue the actual work
    if (this.withdrawalQueue) {
      await this.withdrawalQueue.add(
        'process-withdrawal',
        { vaultId, userId, bankDetails, retryCount },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    } else {
      this.logger.warn(`Withdrawal queue not available. Skipping background job for vault ${vaultId}`);
    }

    return {
      status: 'WITHDRAWAL_PENDING',
      message: 'Withdrawal initiated. Processing in background.',
    };
  }

  public async scheduleWithdrawalRetry(
    vaultId: string,
    userId: string,
    bankDetails: any,
    retryCount: number,
  ) {
    if (!this.withdrawalQueue) {
      this.logger.warn(
        `[WITHDRAWAL RETRY BYPASS] Withdrawal queue not available. Retry for vault ${vaultId} skipped.`,
      );
      return;
    }
    this.logger.log(
      `Scheduling withdrawal retry for vault ${vaultId}, attempt ${retryCount + 1}`,
    );
    await this.withdrawalQueue.add(
      'process-withdrawal',
      { vaultId, userId, bankDetails, retryCount },
      { delay: 5 * 60 * 1000 }, // 5 minutes
    );
  }

  async confirmPayment(vaultId: string, userId: string): Promise<any> {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException(
        'You do not have permission to confirm payment for this vault',
      );

    this.logger.log(
      `[PAYMENT CONFIRMATION] User ${userId} signaled payment for vault ${vaultId}`,
    );

    // In development, we automatically trigger the mock deposit simulation
    if (
      this.configService.get('NODE_ENV') !== 'production' ||
      this.configService.get('TESTNET_MODE') === 'true'
    ) {
      this.logger.log(
        `[PAYMENT CONFIRMATION] Triggering auto-mock for simulation environment`,
      );
      return this.mockPartnaDeposit(vaultId);
    }

    return { message: 'Confirmation received. Verification in progress.' };
  }

  async mockPartnaDeposit(
    vaultId: string,
    amount?: number,
    accountName?: string,
  ): Promise<any> {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true },
    });
    if (!vault) throw new NotFoundException('Vault not found');

    const businessUsername = this.configService.get<string>('PARTNA_API_USER');
    const mockAmount =
      amount || vault.partnaFromAmount || Number(vault.partnaExpectedAmount);
    const mockCurrency = vault.partnaFromCurrency || 'NGN';
    const isFiat = mockCurrency === 'NGN' || mockCurrency === 'KES';

    // Pre-flight health check (Simulation only)
    if (
      this.configService.get('NODE_ENV') !== 'production' ||
      this.configService.get('TESTNET_MODE') === 'true'
    ) {
      try {
        const celoBalance =
          await this.blockchainService.getTreasuryCELOBalance();
        const treasuryAddress = this.blockchainService.getTreasuryAddress();

        if (celoBalance < ethers.parseEther('0.05')) {
          this.logger.warn(
            `[TREASURY ALERT] wallet_dispute (${treasuryAddress}) is extremely low on CELO (< 0.05). Mock deposit bridge may fail.`,
          );
        }
      } catch (e) {
        this.logger.error('Failed to perform treasury pre-flight check', e);
      }
    }

    const rawAccountName = accountName || vault.partnaAccountName;
    let finalAccountName = rawAccountName
      ?.replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();

    // Workaround: Partna Staging often returns 'TEST-MANAGED-ACCOUNT' as a placeholder,
    // but the mock endpoint requires the Customer ID or sanitized customer name.
    // If the vault has a partnaCustomerId, it's generally the most reliable identifier for mocking.
    const fallbackId =
      vault.client?.partnaCustomerId ||
      vault.client?.name?.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    if (finalAccountName === 'testmanagedaccount' || (isFiat && fallbackId)) {
      if (fallbackId) {
        this.logger.log(
          `[PARTNA MOCK DEPOSIT] Using client fallback for simulation: ${fallbackId}`,
        );
        finalAccountName = fallbackId;
      }
    }

    if (!finalAccountName) {
      throw new BadRequestException(
        'No Partna account name found on vault. Has the ramp been initiated?',
      );
    }

    this.logger.log(
      `[PARTNA MOCK DEPOSIT] vaultId:${vaultId} accountName:${finalAccountName} amount:${mockAmount} currency:${mockCurrency}`,
    );

    const networkMap: Record<string, string> = {
      NGN: 'naira',
      KES: 'kenyanshilling',
      USDC: 'celo',
      CUSD: 'celo',
    };

    let mockResponse: any;

    if (isFiat) {
      if (
        mockCurrency === 'KES' &&
        this.configService.get('TESTNET_MODE') === 'true'
      ) {
        this.logger.log(
          `[VAULT MOCK] KES mock skipped (Partna v4 limitation). Simulating internally...`,
        );
        mockResponse = {
          success: true,
          message: 'Simulated KES mock deposit internally',
        };
      } else {
        // Onramp simulation should use the fiat-specific mock endpoint with minimal payload.
        mockResponse = await this.partnaService.mockDepositFiat({
          accountName: finalAccountName,
          amount: Number(mockAmount),
          currency: mockCurrency,
          username: businessUsername || undefined,
        });
      }
    } else {
      // Crypto simulations continue to use the generic mock deposit endpoint.
      mockResponse = await this.partnaService.mockDeposit({
        accountName: finalAccountName,
        amount: Number(mockAmount),
        currency: mockCurrency,
        username: businessUsername!,
        network: 'celo',
        reference: vault.partnaRampReference || `mock_ref_${Date.now()}`,
        isRamp: true,
        confirmations: 10,
        transactionID: `mock_id_${Date.now()}`,
        txHash: `mock_tx_${Math.random().toString(36).substring(7).toUpperCase()}`,
      });
    }

    // [STAGING BRIDGE] Locally trigger on-chain bridge to bridge the fiat-to-token settlement
    if (
      this.configService.get('NODE_ENV') !== 'production' ||
      this.configService.get('TESTNET_MODE') === 'true'
    ) {
      this.logger.log(
        `[DEVELOPMENT] Partna Mock Success. Scheduling local on-chain bridge for vault ${vaultId}...`,
      );

      // Immediately mark as processing in DB so UI can show a loading state
      await this.prisma.vault.update({
        where: { id: vaultId },
        data: { status: VaultStatus.PROCESSING_PAYMENT },
      });

      // Mimic network latency
      setTimeout(async () => {
        try {
          this.logger.log(
            `[DEVELOPMENT] Executing local simulation bridge for vault ${vaultId}`,
          );
          await this.completeFundingLocally(vaultId);
        } catch (e) {
          this.logger.error(
            `[DEVELOPMENT] Local simulation bridge failed for vault ${vaultId}`,
            e,
          );
        }
      }, 2500);
    }

    return mockResponse;
  }

  /**
   * Internal simulation helper to trigger the "Funded" logic locally
   * without waiting for a webhook from Partna.
   */
  async completeFundingLocally(vaultId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true },
    });

    if (!vault || vault.status === 'FUNDED') return;

    this.logger.log(
      `[SIMULATION] Completing funding locally for vault ${vault.id}`,
    );

    // 1. Update DB Status
    await this.prisma.$transaction(async (tx) => {
      await tx.vault.update({
        where: { id: vault.id },
        data: { status: 'FUNDED' },
      });

      await tx.ledgerEntry.updateMany({
        where: { vaultId: vault.id, status: 'PENDING' },
        data: { status: 'CONFIRMED' },
      });
    });

    // 2. Trigger Blockchain Deposit
    // 2. Trigger Blockchain Deposit (Simulation)
    if (vault.vaultAddress) {
      try {
        this.logger.log(
          `[SIMULATION] Automatically depositing ${vault.totalAmount} into Vault Contract ${vault.vaultAddress}`,
        );

        const blockchainTxHash = await this.blockchainService.depositToVault(
          vault.vaultAddress,
          vault.totalAmount,
          vault.tokenAddress,
        );

        this.logger.log(
          `[SIMULATION] Blockchain deposit successful: ${blockchainTxHash}`,
        );
      } catch (error: any) {
        // If the contract says it's already funded, we can treat it as success for the DB simulation
        const isAlreadyFunded = 
          error.message?.includes('already funded') || 
          error.reason?.includes('already funded') ||
          error.data?.includes('already funded');

        if (isAlreadyFunded) {
          this.logger.log(`[SIMULATION] Vault already funded on-chain. Syncing DB...`);
        } else {
          this.logger.error(
            `[SIMULATION] Failed to trigger on-chain deposit`,
            error,
          );
        }
      }
    }

    // Invalidate Cache for consistency
    try {
      await this.invalidateVaultCache(
        vault.id,
        vault.clientId,
        vault.freelancerId,
      );
      this.logger.log(`[VAULT FUND] Cache invalidated for vault:${vault.id}`);
    } catch (cacheErr) {
      this.logger.error(`[VAULT FUND] Failed to invalidate cache`, cacheErr);
    }

    // 3. Send Notifications
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
      const freelancer = await this.prisma.user.findUnique({
        where: { id: vault.freelancerId },
      });
      if (freelancer) {
        // Send Email to Freelancer
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
    } else {
      // Check for a pending invite and send invitation email
      const invite = await this.prisma.invite.findFirst({
        where: { vaultId: vault.id, status: InviteStatus.PENDING },
      });

      if (invite) {
        this.logger.log(
          `Vault funded (local). Sending invitation email to guest freelancer ${invite.email}...`,
        );
        await this.mailsService.sendInviteEmail(
          invite.email,
          vault.client?.name || 'A client',
          vault.title,
          Number(amountFormatted),
          invite.token,
          vault.localCurrency || undefined,
          vault.localAmount || undefined,
        );
      }
    }

    // 4. Invalidate Cache
    const keys = [
      `vaults:detail:${vault.id}`,
      `vaults:list:CLIENT:${vault.clientId}`,
    ];
    if (vault.freelancerId) {
      keys.push(`vaults:list:FREELANCER:${vault.freelancerId}`);
    }
    await Promise.all(keys.map((k) => this.redis.del(k)));

    this.logger.log(`[SIMULATION] Cache invalidated for vault ${vault.id}`);
  }

  /** @deprecated Legacy v2 flow */
  async handlePartnaCallback(
    vaultId: string,
    vouchercode: string,
    voucherId: string,
  ) {
    // This is legacy v2 code, keeping just in case of transition issues
    this.logger.warn(
      'Legacy handlePartnaCallback called - this flow should be deprecated',
    );
    return { success: false, message: 'Deprecated flow' };
  }

  async submit(
    vaultId: string,
    dto: SubmitVaultDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    if (dto.idempotencyKey) {
      const cachedResponse = await this.redis.get(
        `idempotency:${dto.idempotencyKey}`,
      );
      if (cachedResponse) {
        return JSON.parse(cachedResponse);
      }
    }

    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault || vault.freelancerId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized or not the assigned freelancer',
      });
    }

    if (vault.status !== VaultStatus.FUNDED) {
      throw new BadRequestException({
        code: 'INVALID_STATE',
        message: 'Vault must be FUNDED',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Create the submission block
      const submission = await (tx.submission.create as any)({
        data: {
          vaultId,
          notes: dto.comments,
          filesJson: (dto.files || []) as any,
          deliverableStatus: (dto.deliverableStatus || []) as any,
          deliverables: {
            connect:
              dto.deliverableStatus
                ?.filter((d) => d.included)
                .map((d) => ({ id: d.deliverableId })) || [],
          },
          submittedBy: userId,
        },
      });

      return { vault, submission };
    });

    await this.invalidateVaultCache(vaultId, vault.clientId, userId);

    // Notify client about the submission
    await this.notificationsService.createNotification(vault.clientId, {
      type: 'vault',
      title: 'Work Submitted',
      message: `The freelancer has submitted work for vault "${vault.title}".`,
      action: `/client/vault/${vaultId}`,
    });

    // Send email to client
    const client = await this.prisma.user.findUnique({ where: { id: vault.clientId } });
    const freelancer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (client) {
      await this.mailsService.sendVaultStatusEmail(
        client.email,
        client.name || 'Client',
        vault.title,
        'work_submitted',
        `/client/vault/${vaultId}`,
        freelancer?.name || 'The freelancer',
      );
    }

    if (dto.idempotencyKey) {
      await this.redis.set(
        `idempotency:${dto.idempotencyKey}`,
        JSON.stringify(result),
        24 * 60 * 60,
      );
    }

    return result;
  }

  async release(
    vaultId: string,
    dto: ReleaseVaultDto,
    userId: string,
    role: string,
  ) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }

    // Guard against double-release
    if (
      vault.status === VaultStatus.RELEASING ||
      vault.status === (VaultStatus.RELEASED as any)
    ) {
      throw new BadRequestException('Release already in progress or completed.');
    }

    // Enforce Tier 2 KYC for fund release
    const client = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (client?.kycStatus !== KycStatus.VERIFIED && this.configService.get('TESTNET_MODE') !== 'true') {
      throw new BadRequestException({
        code: 'KYC_REQUIRED',
        message: 'Identity verification (Tier 2) is required to release funds.',
      });
    }

    // Immediately mark as releasing and return to client
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: { status: VaultStatus.RELEASING as any },
    });

    // Queue the actual work
    if (this.vaultReleaseQueue) {
      await this.vaultReleaseQueue.add(
        'process-release',
        { vaultId, userId, dto },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    } else {
      this.logger.warn(`Vault release queue not available. Skipping background job for vault ${vaultId}`);
    }

    // Send email to freelancer
    if (vault.freelancerId) {
      const freelancer = await this.prisma.user.findUnique({ where: { id: vault.freelancerId } });
      const client = await this.prisma.user.findUnique({ where: { id: userId } });
      if (freelancer) {
        await this.mailsService.sendVaultStatusEmail(
          freelancer.email,
          freelancer.name || 'Freelancer',
          vault.title,
          'vault_released',
          `/freelancer/vault/${vaultId}`,
          client?.name || 'The client',
        );
      }
    }

    return {
      status: (VaultStatus as any).RELEASING,
      message: 'Release initiated. Processing in background.',
    };
  }

  async refund(
    vaultId: string,
    dto: RefundVaultDto,
    userId: string,
    role: string,
  ) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }

    // Guard against double-refund
    if (
      vault.status === VaultStatus.REFUNDING ||
      vault.status === (VaultStatus.REFUNDED as any)
    ) {
      throw new BadRequestException('Refund already in progress or completed.');
    }

    // Immediately mark as refunding and return to client
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: { status: VaultStatus.REFUNDING as any },
    });

    // Queue the actual work
    if (this.vaultRefundQueue) {
      await this.vaultRefundQueue.add(
        'process-refund',
        { vaultId, userId, dto },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    } else {
      this.logger.warn(`Vault refund queue not available. Skipping background job for vault ${vaultId}`);
    }

    return {
      status: (VaultStatus as any).REFUNDING,
      message: 'Refund initiated. Processing in background.',
    };
  }

  async updateStatus(
    id: string,
    dto: UpdateVaultStatusDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    const vault = await this.prisma.vault.findUnique({ where: { id } });
    if (!vault)
      throw new NotFoundException({
        code: 'VAULT_NOT_FOUND',
        message: 'Vault not found',
      });
    if (vault.clientId !== userId)
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });

    const updatedVault = await this.prisma.vault.update({
      where: { id },
      data: { status: dto.status as any },
    });

    if (dto.status === VaultStatus.CHANGES_REQUESTED && updatedVault.freelancerId) {
      const freelancer = await this.prisma.user.findUnique({ where: { id: updatedVault.freelancerId } });
      const client = await this.prisma.user.findUnique({ where: { id: userId } });
      if (freelancer) {
        await this.mailsService.sendVaultStatusEmail(
          freelancer.email,
          freelancer.name || 'Freelancer',
          updatedVault.title,
          'changes_requested',
          `/freelancer/vault/${id}`,
          client?.name || 'The client',
        );
      }
    }

    await this.invalidateVaultCache(id, userId, updatedVault.freelancerId);
    return this.formatVault(updatedVault);
  }

  async requestRelease(vaultId: string, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault || vault.freelancerId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized or not the assigned freelancer',
      });
    }

    if (vault.status !== VaultStatus.FUNDED) {
      throw new BadRequestException({
        code: 'INVALID_STATE',
        message: 'Vault must be IN PROGRESS (FUNDED) to request release',
      });
    }

    // Notify client about the release request
    await this.notificationsService.createNotification(vault.clientId, {
      type: 'vault',
      title: 'Release Requested',
      message: `The freelancer has requested a release for vault "${vault.title}". Please review the work and release the funds.`,
      action: `/client/vault/${vaultId}`,
    });

    // Send email to client
    const client = await this.prisma.user.findUnique({ where: { id: vault.clientId } });
    const freelancer = await this.prisma.user.findUnique({ where: { id: userId } });
    if (client) {
      await this.mailsService.sendVaultStatusEmail(
        client.email,
        client.name || 'Client',
        vault.title,
        'release_requested',
        `/client/vault/${vaultId}`,
        freelancer?.name || 'The freelancer',
      );
    }

    return { message: 'Release request sent to the client' };
  }

  private formatVault(vault: any) {
    const paidAmount =
      vault.ledgerEntries
        ?.filter(
          (le: any) =>
            le.type === LedgerEntryType.RELEASE &&
            le.status === TransactionStatus.CONFIRMED,
        )
        .reduce((sum: bigint, le: any) => sum + BigInt(le.amount), BigInt(0)) ||
      BigInt(0);

    return {
      id: vault.id,
      title: vault.title,
      description: vault.description,
      type: vault.type,
      status: vault.status,
      vaultAddress: vault.vaultAddress,
      tokenAddress: vault.tokenAddress,
      tokenSymbol: vault.tokenSymbol,
      tokenDecimals: vault.tokenDecimals,
      chainId: vault.chainId,
      localCurrency: vault.localCurrency,
      localAmount: vault.localAmount,
      totalAmount: vault.totalAmount.toString(),
      amount: vault.amount.toString(),
      paidAmount: paidAmount.toString(),
      formattedTotalAmount: ethers.formatUnits(
        vault.totalAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
      formattedPaidAmount: ethers.formatUnits(
        paidAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
      settlementFeeUSD: vault.settlementFeeUSD,
      processingFeeUSD: vault.processingFeeUSD,
      totalFeeUSD: vault.totalFeeUSD,
      freelancerReceivesUSD: vault.freelancerReceivesUSD,
      localSettlementFee: vault.localSettlementFee,
      localProcessingFee: vault.localProcessingFee,
      localFreelancerReceives: vault.localFreelancerReceives,
      isFrozen: vault.isFrozen,
      frozenReason: vault.frozenReason,
      clientId: vault.clientId,
      clientName: vault.client?.name,
      freelancerId: vault.freelancerId,
      freelancerName: vault.freelancer?.name,
      freelancerEmail: vault.freelancer?.email,
      createdAt: vault.createdAt.toISOString(),
      deliverables: vault.deliverables || [],
      submissions: vault.submissions || [],
      partnaAccountName: vault.partnaAccountName,
      partnaAccountNumber: vault.partnaAccountNumber,
      partnaBankName: vault.partnaBankName,
      partnaExpiryDate: vault.partnaExpiryDate?.toISOString(),
      partnaExpectedAmount: vault.partnaExpectedAmount,
      partnaFromAmount: vault.partnaFromAmount,
      partnaFromCurrency: vault.partnaFromCurrency,
      partnaRampReference: vault.partnaRampReference,
      partnaRateKey: vault.partnaRateKey,
      ledgerEntries: vault.ledgerEntries || [],
    };
  }

  private hashRequest(data: any): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex');
  }

  /**
   * Client requests an administrative refund
   */
  async requestRefund(id: string, userId: string, dto: any) {
    const vault = await (this.prisma.vault.findUnique as any)({
      where: { id },
      include: { refundRequest: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException('Only the client can request a refund');

    // Enforce Tier 2 KYC for refund requests
    const client = await this.prisma.user.findUnique({ where: { id: userId } });
    if (client?.kycStatus !== KycStatus.VERIFIED && this.configService.get('TESTNET_MODE') !== 'true') {
      throw new BadRequestException(
        'Identity verification (Tier 2) is required to request a refund.',
      );
    }

    if (vault.status === VaultStatus.RELEASED) {
      throw new BadRequestException('Cannot refund a released vault');
    }

    // New Rules: Refund only if contractor hasn't accepted OR if there is a dispute
    const hasAccepted = !!vault.freelancerId;
    const isDisputed = vault.status === VaultStatus.DISPUTED;

    if (hasAccepted && !isDisputed) {
      throw new BadRequestException(
        'Refunds for accepted projects are only available if a dispute is raised.',
      );
    }

    if (vault.refundRequest) {
      throw new BadRequestException('Refund already requested');
    }

    // Create the administrative refund request
    return await this.prisma.refundRequest.create({
      data: {
        vaultId: id,
        clientId: userId,
        amount: vault.totalAmount,
        payoutMethod: dto.payoutMethod,
        payoutDetails: dto.payoutDetails,
        status: 'PENDING' as any,
      },
    });
  }

  /**
   * Client reassigns the vault to another freelancer
   */
  async updateFreelancer(id: string, userId: string, dto: any) {
    const vault = await (this.prisma.vault.findUnique as any)({
      where: { id },
      include: { client: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException('Only the client can reassign');

    // 1. Find or create the new freelancer
    const newFreelancer = await this.prisma.user.findUnique({
      where: { email: dto.freelancerEmail },
      include: { wallet: true },
    });

    const newFreelancerId = newFreelancer?.id || null;
    const newFreelancerAddress = newFreelancer?.wallet?.address || null;

    // 2. Update the vault in DB
    const updatedVault = await this.prisma.vault.update({
      where: { id },
      data: {
        // We no longer update freelancerId here immediately.
        // It remains null (or its previous value) until the new freelancer accepts.
        // freelancerId: newFreelancerId,
      },
    });

    // 3. If on-chain deployment exists, hand over to the new address
    // (or Arbiter if they are a guest)
    if (vault.vaultAddress) {
      const finalAddress =
        newFreelancerAddress ||
        this.configService.get<string>('ARBITER_ADDRESS')!;
      try {
        await this.blockchainService.updateVaultFreelancer(
          vault.vaultAddress,
          finalAddress,
        );
      } catch (err) {
        this.logger.error(`On-chain reassignment failed for vault ${id}`, err);
      }
    }

    // 4. Update or send invitation
    if (dto.freelancerEmail) {
      // Deactivate any existing pending invites for this vault to avoid duplicates
      await this.prisma.invite.updateMany({
        where: { vaultId: id, status: InviteStatus.PENDING },
        data: { status: InviteStatus.EXPIRED as any },
      });

      const invite = await this.invitesService.create(
        {
          vaultId: id,
          email: dto.freelancerEmail,
          expiresInDays: 7,
        },
        userId,
      );

      // Only send immediately if funded. If DRAFT, wait for funding webhook.
      if (vault.status === VaultStatus.FUNDED) {
        await this.mailsService.sendInviteEmail(
          dto.freelancerEmail,
          vault.client?.name || 'A client',
          vault.title,
          Number(
            ethers.formatUnits(
              vault.totalAmount || BigInt(0),
              vault.tokenDecimals || 6,
            ),
          ),
          invite.token,
        );
      } else {
        this.logger.log(
          `Vault is in DRAFT. Post-funding webhook will send the invite to ${dto.freelancerEmail}`,
        );
      }
    }

    return updatedVault;
  }
}
