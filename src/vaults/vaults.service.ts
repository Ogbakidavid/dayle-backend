import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
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
    @InjectQueue('withdrawal-retry')
    private withdrawalRetryQueue: Queue,
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
    const client = await prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    const clientAddress = client?.wallet?.address;

    if (!clientAddress) {
      throw new BadRequestException('Client does not have a connected wallet.');
    }

    // 2. Resolve Freelancer info
    let freelancerId: string | null = null;
    let freelancerAddress: string =
      '0x0000000000000000000000000000000000000000';

    if (dto.freelancerEmail) {
      const freelancer = await prisma.user.findUnique({
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

    // Convert totalAmount to BigInt (smallest units) with 3% gross-up
    // Logic: RequestedBudget = TotalAmount * 0.97 => TotalAmount = RequestedBudget / 0.97
    // Using integer math to avoid precision issues: (Budget * 10000) / 9700
    const budgetWei = ethers.parseUnits(
      dto.totalAmount.toString(),
      dto.tokenDecimals,
    );
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

    const vault = await (prisma.vault.create as any)({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type as any,
        totalAmount: budgetBigInt, // Store gross budget
        amount: budgetBigInt,      // Also store as amount initially
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
        localAmount: dto.localAmount || dto.totalAmount,
      },
      include: {
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
        deliverables: true,
      },
    });

    // 4. Create a pending invite for the freelancer (always required for acceptance flow)
    // The actual email will be sent post-funding via WebhooksService
    if (dto.freelancerEmail) {
      try {
        this.logger.log(
          `Creating pending invitation for ${dto.freelancerEmail}...`,
        );
        await this.invitesService.create(
          {
            vaultId: vault.id,
            email: dto.freelancerEmail,
            expiresInDays: 7,
          },
          userId,
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

    const vaults = await prisma.vault.findMany({
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
      const vault = await prisma.vault.findUnique({
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

    if (vault.client.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException('KYC verification must be completed before funding.');
    }

    // Calculate Gross Amount (Budget + 0.5% processing fee)
    const budgetUSD = parseFloat(
      ethers.formatUnits(vault.totalAmount || BigInt(0), vault.tokenDecimals || 6),
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

    return result;
  }

  async initiatePartnaFunding(vaultId: string, userId: string, dto: FundVaultDto) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId)
      throw new ForbiddenException('Not authorized');

    if (!vault.client.paymentAccountReady) {
      throw new BadRequestException('Payment account setup (BVN/Phone) must be completed before funding.');
    }

    // Calculate tiered fees based on Budget
    const budgetUSD = parseFloat(
      ethers.formatUnits(vault.totalAmount || BigInt(0), vault.tokenDecimals || 6),
    );
    const grossUSD = budgetUSD * 1.005;
    const fees = calculateDayleFee(budgetUSD);
    
    // Fetch live rate or use provided one
    const currency = dto.currency || (vault.client.country === 'Kenya' ? 'KES' : 'NGN');
    let rate: number;
    let rateKey: string;

    // For simplicity and correctness, we re-fetch/verify the rate
    const rateResult = await this.ratesService.getTransactionRate(currency, grossUSD, vaultId, 'funding');
    rate = rateResult.rate;
    rateKey = rateResult.rateKey!;

    // Local amount = grossUSD / (USDC/Local)
    const localAmount = dto.amount || Math.round(grossUSD / rate);

    const rampReference = crypto.randomBytes(16).toString('hex');
    const network = currency === 'KES' ? 'mpesa' : 'naira';

    const rampResponse = await this.partnaService.createRamp({
      type: 'fiatToCrypto',
      fromCurrency: currency,
      fromNetwork: network,
      toCurrency: 'USDC',
      toNetwork: 'celo',
      fromAmount: localAmount,
      cryptoAddress: vault.vaultAddress || this.configService.get<string>('VAULT_FACTORY_ADDRESS'),
      rateKey: rateKey,
      rampReference: rampReference,
      accountName: vault.client.name,
      cancelPendingRampRequest: false
    });

    const rampData = rampResponse.data;

    // Store ramp details in vault
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: {
        status: VaultStatus.AWAITING_PAYMENT,
        partnaAccountName: rampData.accountName,
        partnaAccountNumber: rampData.accountNumber,
        partnaBankName: rampData.bankName,
        partnaExpiryDate: new Date(rampData.expiryDate * 1000),
        partnaExpectedAmount: rampData.toAmount,
        partnaFromAmount: rampData.fromAmount,
        partnaFromCurrency: currency,
        partnaRampReference: rampReference,
        partnaRateKey: rateKey,
      }
    });

    return {
      bankName: rampData.bankName,
      accountNumber: rampData.accountNumber,
      accountName: rampData.accountName,
      amount: rampData.fromAmount,
      currency: currency,
      reference: rampReference,
      expiresAt: new Date(rampData.expiryDate * 1000).toISOString(),
      partnaFee: rampData.feeInFromCurrency,
    };
  }

  async initiateWithdrawal(
    vaultId: string, 
    userId: string, 
    bankDetails: { accountNumber: string, bankCode: string, accountName: string, bankName?: string },
    retryCount: number = 0
  ) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { freelancer: { include: { wallet: true } } },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.freelancerId !== userId) throw new ForbiddenException('Not authorized');

    if (vault.freelancer?.kycStatus !== KycStatus.VERIFIED || !vault.freelancer?.paymentAccountReady) {
      throw new BadRequestException('KYC verification and payment account setup must be completed before withdrawal.');
    }
    
    // Freelancer can withdraw if status is RELEASED or if we are retrying a PENDING one
    if (vault.status !== VaultStatus.RELEASED && vault.status !== VaultStatus.WITHDRAWAL_PENDING) {
      throw new BadRequestException('Funds have not been released yet');
    }

    // Deduct 0.5% app processing fee from freelancer's payout
    const amountUSD = Number(vault.freelancerReceivesUSD || 0) * 0.995;
    if (amountUSD <= 0) {
      throw new BadRequestException('Withdrawal amount must be greater than zero.');
    }

    const currency = vault.freelancer?.country === 'Kenya' ? 'KES' : 'NGN';
    const network = currency === 'KES' ? 'mpesa' : 'naira';

    let rampReference = crypto.randomBytes(16).toString('hex');

    // 1. Try Paycrest as Primary
    try {
      this.logger.log(`[PAYCREST RATE REQUEST] vaultId: ${vaultId}, amountUSD: ${amountUSD}`);
      const rateResponse = await this.paycrestService.getExchangeRate(amountUSD, currency);
      const rate = parseFloat(rateResponse.data);
      this.logger.log(`[PAYCREST RATE RESPONSE] rate: ${rate}`);

      this.logger.log(`[PAYCREST ORDER REQUEST] vaultId: ${vaultId}`);
      const orderResponse = await this.paycrestService.createOrder({
        amount: amountUSD,
        currency,
        customerEmail: vault.freelancer.email,
        reference: rampReference,
        vaultId,
        rate,
        bankDetails: {
          account_number: bankDetails.accountNumber,
          bank_code: bankDetails.bankCode,
          account_name: bankDetails.accountName,
        },
      });
      this.logger.log(`[PAYCREST ORDER RESPONSE] orderId: ${orderResponse.id}`);
      this.logger.log(`[OFFRAMP PROVIDER: PAYCREST] vaultId: ${vaultId}`);

      const receiveAddress = orderResponse.receiveAddress;
      if (!receiveAddress) throw new Error('No receive address from Paycrest');

      const amountWei = ethers.parseUnits(amountUSD.toString(), vault.tokenDecimals);
      this.logger.log(`[PAYCREST WITHDRAWAL USDC SENT] vaultId: ${vaultId}, amount: ${amountUSD}, toAddress: ${receiveAddress}`);
      
      await this.blockchainService.transferTreasuryToken(receiveAddress, amountWei, vault.tokenAddress);

      await this.prisma.vault.update({
        where: { id: vaultId },
        data: {
          status: VaultStatus.WITHDRAWAL_PENDING,
          paycrestOrderId: orderResponse.id,
          paycrestReceiveAddress: receiveAddress,
          paycrestValidUntil: orderResponse.validUntil ? new Date(orderResponse.validUntil) : null,
          paycrestRate: rate,
          paycrestOrderCreatedAt: new Date(),
        },
      });

      return {
        rampReference,
        expectedLocalAmount: amountUSD * rate,
        currency,
        status: 'WITHDRAWAL_PENDING'
      };
    } catch (paycrestError) {
      this.logger.warn(`Paycrest withdrawal failed, falling back to Partna: ${paycrestError.message}`);
      
      // 2. Partna Fallback
      try {
        this.logger.log(`[PARTNA WITHDRAWAL INITIATED] vaultId: ${vaultId}, amountUSD: ${amountUSD}`);
        const { rate, rateKey } = await this.ratesService.getTransactionRate(currency, amountUSD, vaultId, 'withdrawal');

        const rampResponse = await this.partnaService.createRamp({
          type: 'cryptoToFiat',
          fromCurrency: 'USDC',
          fromNetwork: 'celo',
          toCurrency: currency,
          toNetwork: network,
          fromAmount: amountUSD,
          accountNumber: bankDetails.accountNumber,
          bankCode: bankDetails.bankCode,
          accountName: bankDetails.accountName,
          rateKey: rateKey,
          rampReference: rampReference,
          cancelPendingRampRequest: false
        });

        this.logger.log(`[OFFRAMP PROVIDER: PARTNA FALLBACK] vaultId: ${vaultId}, rampId: ${rampResponse.data?.rampReference || rampReference}`);

        const cryptoAddress = rampResponse.data?.cryptoAddress;
        if (!cryptoAddress) throw new Error('No crypto address from Partna');

        const amountWei = ethers.parseUnits(amountUSD.toString(), vault.tokenDecimals);
        this.logger.log(`[PARTNA OFFRAMP USDC SENT] vaultId: ${vaultId}, amount: ${amountUSD}, toAddress: ${cryptoAddress}`);
        
        await this.blockchainService.transferTreasuryToken(cryptoAddress, amountWei, vault.tokenAddress);

        await this.prisma.vault.update({
          where: { id: vaultId },
          data: {
            status: VaultStatus.WITHDRAWAL_PENDING,
            partnaRampReference: rampReference,
            partnaRateKey: rateKey,
            partnaBankName: bankDetails.bankName,
            partnaAccountNumber: bankDetails.accountNumber,
            partnaAccountName: bankDetails.accountName,
          },
        });

        return {
          rampReference,
          expectedLocalAmount: rampResponse.data.toAmount,
          currency,
          status: 'WITHDRAWAL_PENDING'
        };
      } catch (partnaError) {
        this.logger.error(`Withdrawal totally failed for vault ${vaultId}: ${partnaError.message}`);
        
        if (retryCount < 2) {
          await this.scheduleWithdrawalRetry(vaultId, userId, bankDetails, retryCount + 1);
          await this.prisma.vault.update({
            where: { id: vaultId },
            data: { status: VaultStatus.WITHDRAWAL_PENDING },
          });

          return {
            status: 'WITHDRAWAL_PENDING',
            message: 'Withdrawal failed. We will retry automatically.'
          };
        } else {
          this.logger.error(`[ADMIN ALERT] Withdrawal failed for vault ${vaultId} after multiple attempts`);
          throw new BadRequestException('Withdrawal failed after multiple attempts. Please contact support.');
        }
      }
    }
  }

  public async scheduleWithdrawalRetry(
    vaultId: string,
    userId: string,
    bankDetails: any,
    retryCount: number
  ) {
    this.logger.log(`Scheduling withdrawal retry for vault ${vaultId}, attempt ${retryCount + 1}`);
    await this.withdrawalRetryQueue.add(
      'withdrawal-retry',
      { vaultId, userId, bankDetails, retryCount },
      { delay: 5 * 60 * 1000 } // 5 minutes
    );
  }

  async mockPartnaDeposit(vaultId: string, amount?: number, accountName?: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: { client: true },
    });
    if (!vault) throw new NotFoundException('Vault not found');

    if (vault.client.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException('KYC verification must be completed before mock deposit.');
    }

    const businessUsername = this.configService.get<string>('PARTNA_API_USER');

    const mockAmount = amount || vault.partnaFromAmount || Number(vault.partnaExpectedAmount);
    const mockCurrency = vault.partnaFromCurrency || (vault.client.country === 'Kenya' ? 'KES' : 'NGN');

    console.log(`[PARTNA MOCK DEPOSIT REQUEST] vaultId:${vaultId} amount:${mockAmount} currency:${mockCurrency}`);

    return this.partnaService.mockDepositFiat({
      accountName: accountName || vault.partnaAccountName || vault.client.name,
      amount: Number(mockAmount),
      currency: mockCurrency,
      username: businessUsername!,
    });
  }

  /** @deprecated Legacy v2 flow */
  async handlePartnaCallback(vaultId: string, vouchercode: string, voucherId: string) {
    // This is legacy v2 code, keeping just in case of transition issues
    this.logger.warn('Legacy handlePartnaCallback called - this flow should be deprecated');
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

    const vault = await prisma.vault.findUnique({
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

    const result = await prisma.$transaction(async (tx) => {
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
    const prisma = this.prisma;
    if (dto.idempotencyKey) {
      const cachedResponse = await this.redis.get(
        `idempotency:${dto.idempotencyKey}`,
      );
      if (cachedResponse) {
        return JSON.parse(cachedResponse);
      }
    }

    const vault = await (this.prisma.vault.findUnique as any)({
      where: { id: vaultId },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }
    const budgetUSD = parseFloat(
      ethers.formatUnits(
        vault.totalAmount || BigInt(0),
        vault.tokenDecimals || 6,
      ),
    );
    const fees = calculateDayleFee(budgetUSD);

    const result = await prisma.$transaction(async (tx) => {
      const updatedVault = await tx.vault.update({
        where: { id: vaultId },
        data: {
          status: VaultStatus.RELEASED as any,
          settlementFeeUSD: fees.settlementFeeUSD,
          totalFeeUSD: fees.totalFeeUSD,
          freelancerReceivesUSD: fees.freelancerReceivesUSD,
        },
      });

      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId: vault.freelancerId!,
          vaultId: vault.id,
          type: LedgerEntryType.RELEASE,
          amount: ethers.parseUnits(
            fees.freelancerReceivesUSD.toString(),
            vault.tokenDecimals,
          ),
          currency: vault.tokenSymbol || 'USD',
          status: TransactionStatus.CONFIRMED,
          description: `Release for vault: ${vault.title} (Net of fees)`,
          completedAt: new Date(),
        },
      });

      // Also create a fee ledger entry for tracking
      await tx.ledgerEntry.create({
        data: {
          userId: vault.clientId,
          vaultId: vault.id,
          type: LedgerEntryType.FEE,
          amount: ethers.parseUnits(
            fees.totalFeeUSD.toString(),
            vault.tokenDecimals,
          ),
          currency: vault.tokenSymbol || 'USD',
          status: TransactionStatus.CONFIRMED,
          description: `Platform fee for vault: ${vault.title}`,
          completedAt: new Date(),
        },
      });

      return { vault: updatedVault, ledgerEntry };
    });

    // 2. Trigger on-chain release if a vault address exists
    if (vault.vaultAddress) {
      try {
        await this.blockchainService.releaseVault(
          vault.vaultAddress,
          fees.totalFeeBasisPoints,
        );
      } catch (error) {
        this.logger.error(
          `On-chain release failed for vault ${vaultId}`,
          error,
        );
      }
    }

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);

    // Notify freelancer about the release
    if (vault.freelancerId) {
      await this.notificationsService.createNotification(vault.freelancerId, {
        type: 'payment',
        title: 'Funds Released',
        message: `The client has released the funds for vault "${vault.title}".`,
        action: `/freelancer/vault/${vaultId}`,
      });
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

  async refund(
    vaultId: string,
    dto: RefundVaultDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    // Check idempotency
    if (dto.idempotencyKey) {
      const cachedResponse = await this.redis.get(
        `idempotency:${dto.idempotencyKey}`,
      );
      if (cachedResponse) {
        return JSON.parse(cachedResponse);
      }
    }

    const vault = await (this.prisma.vault.findUnique as any)({
      where: { id: vaultId },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }
    const result = await prisma.$transaction(async (tx) => {
      const updatedVault = await tx.vault.update({
        where: { id: vaultId },
        data: { status: VaultStatus.REFUNDED as any },
      });

      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId,
          vaultId: vault.id,
          type: LedgerEntryType.REFUND,
          amount: vault.totalAmount,
          currency: vault.tokenSymbol || 'USD',
          status: TransactionStatus.CONFIRMED,
          description: `Refund for vault: ${vault.title}`,
          completedAt: new Date(),
        },
      });

      return { success: true, ledgerEntry, vault: updatedVault };
    });

    if (dto.idempotencyKey) {
      await this.redis.set(
        `idempotency:${dto.idempotencyKey}`,
        JSON.stringify(result),
        24 * 60 * 60,
      );
    }

    // 2. Trigger on-chain refund if a vault address exists
    if (vault.vaultAddress) {
      try {
        await this.blockchainService.refundVault(vault.vaultAddress);
      } catch (error) {
        this.logger.error(`On-chain refund failed for vault ${vaultId}`, error);
      }
    }

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);

    // Notify client about the refund
    await this.notificationsService.createNotification(userId, {
      type: 'payment',
      title: 'Funds Refunded',
      message: `The funds for vault "${vault.title}" have been successfully refunded to your account.`,
      action: `/client/vault/${vaultId}`,
    });

    return result;
  }

  async updateStatus(
    id: string,
    dto: UpdateVaultStatusDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    const vault = await prisma.vault.findUnique({ where: { id } });
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

    const updatedVault = await prisma.vault.update({
      where: { id },
      data: { status: dto.status as any },
    });

    await this.invalidateVaultCache(id, userId, updatedVault.freelancerId);
    return this.formatVault(updatedVault);
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
