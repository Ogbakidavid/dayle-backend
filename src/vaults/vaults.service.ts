import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
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
} from '../domain/enums';
import * as crypto from 'crypto';
import { RedisService } from '../common/redis/redis.service';
import { Prisma } from '@prisma/client';
import { ethers } from 'ethers';

import { BlockchainService } from '../common/services/blockchain.service';
import { InvitesService } from '../invites/invites.service';
import { MailsService } from '../notifications/mails.service';

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
    private configService: ConfigService,
  ) {}

  async create(dto: CreateVaultDto, userId: string, role: string) {
    const prisma = this.prisma;

    if (dto.idempotencyKey) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: { key: dto.idempotencyKey },
      });
      if (existing) return existing.responseBody;
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

    try {
      this.logger.log(
        `Deploying vault for client ${clientAddress} and freelancer ${finalFreelancerAddress}`,
      );
      const { vaultAddress } = await this.blockchainService.deployVault(
        clientAddress,
        finalFreelancerAddress,
        dto.totalAmount.toString(),
      );
      deployedVaultAddress = vaultAddress;
    } catch (error) {
      this.logger.error('Vault deployment failed', error);
      // We keep it as DRAFT if deployment fails, so user can retry
    }

    const vault = await prisma.vault.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type,
        totalAmount: dto.totalAmount,
        clientId: userId,
        freelancerId: freelancerId, // Link if they exist
        status: deployedVaultAddress ? VaultStatus.FUNDED : VaultStatus.DRAFT, // If deployed, it's ready for funding
        vaultAddress: deployedVaultAddress || null,
        deliverables: (dto.deliverables || []).map((d) => ({
          ...d,
          id: (d as any).id || crypto.randomUUID(),
        })),
      } as any,
      include: {
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
    });

    // 4. If freelancer is a guest (no user found), create an invite and notify them
    if (dto.freelancerEmail && !freelancerId) {
      try {
        this.logger.log(
          `Freelancer ${dto.freelancerEmail} is a guest. Creating invitation...`,
        );
        const invite = await this.invitesService.create(
          {
            vaultId: vault.id,
            email: dto.freelancerEmail,
            expiresInDays: 7,
          },
          userId,
        );

        await this.mailsService.sendInviteEmail(
          dto.freelancerEmail,
          client?.name || 'A client',
          dto.title,
          dto.totalAmount,
          invite.token,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create invite or send email for guest freelancer ${dto.freelancerEmail}`,
          error,
        );
      }
    }

    if (dto.idempotencyKey) {
      await prisma.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey as string,
          userId,
          endpoint: '/api/vaults',
          requestHash: this.hashRequest(dto),
          responseBody: vault as unknown as Prisma.InputJsonValue,
          statusCode: 201,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
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

  async getById(id: string, userId: string, role: string) {
    const prisma = this.prisma;
    const cacheKey = `vaults:detail:${id}`;
    const cached = await this.redis.get(cacheKey);
    let vaultResult: any;

    if (cached) {
      vaultResult = JSON.parse(cached);
    } else {
    const vault = await (prisma.vault.findUnique as any)({
      where: { id },
      include: {
        submissions: {
          orderBy: { submittedAt: 'desc' },
        },
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
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Not authorized',
      });
    }

    return vaultResult;
  }

  async fund(id: string, dto: FundVaultDto, userId: string, role: string) {
    const prisma = this.prisma;
    const vault = await prisma.vault.findUnique({
      where: { id },
    });

    if (!vault) {
      throw new NotFoundException({
        code: 'VAULT_NOT_FOUND',
        message: 'Vault not found',
      });
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException({
        code: 'UNAUTHORIZED',
        message: 'Only client can fund',
      });
    }

    if (vault.status !== VaultStatus.DRAFT) {
      throw new BadRequestException({
        code: 'INVALID_STATE',
        message: 'Vault not in DRAFT status',
      });
    }

    // Logic for funding (ledger entry, collection voucher)
    const providerRef = `vault_fund_${id}_${Date.now()}`;

    const { user, ledgerEntry } = await this.prisma.$transaction(async (tx) => {
      // Create ledger entry in PENDING status
      const entry = await tx.ledgerEntry.create({
        data: {
          userId,
          vaultId: id,
          type: LedgerEntryType.DEPOSIT,
          amount: vault.totalAmount,
          currency: 'USD',
          status: TransactionStatus.PENDING,
          description: `Funding for vault: ${vault.title}`,
          providerRef,
        },
      });

      // Get user within transaction to ensure data consistency
      const u = await tx.user.findUnique({ where: { id: userId } });
      
      return { user: u, ledgerEntry: entry };
    });

    // Payment router integration (Onramp) - OUTSIDE transaction to avoid timeouts
    let onrampResult;
    try {
      onrampResult = await this.paymentRouter.initiateOnramp({
        amount: vault.totalAmount,
        currency: 'USD',
        reference: providerRef,
        customerEmail: user?.email || '',
        customerFullName: user?.name || 'Dayle User',
      });
    } catch (err) {
      this.logger.warn(
        `Onramp failed, falling back to mock provider for development: ${err.message}`,
      );
      onrampResult = {
        provider: 'mock',
        paymentUrl: `/checkout/${id}/mock-payment?ref=${providerRef}`,
        providerRef,
      };
    }

    // Sync provider reference if it was changed by the provider (e.g. Partna Voucher ID)
    if (onrampResult.providerRef && onrampResult.providerRef !== providerRef) {
      await this.prisma.ledgerEntry.update({
        where: { id: ledgerEntry.id },
        data: { providerRef: onrampResult.providerRef },
      });
      // Update local object for the return value
      ledgerEntry.providerRef = onrampResult.providerRef;
    }

    await this.invalidateVaultCache(id, userId, vault.freelancerId);

    return {
      vault,
      ledgerEntry,
      paymentUrl: onrampResult.paymentUrl,
      provider: onrampResult.provider,
      providerRef: ledgerEntry.providerRef,
    };
  }

  async submit(
    vaultId: string,
    dto: SubmitVaultDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });
    if (existing) return existing.responseBody;

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
          deliverableIds: (dto.deliverableStatus?.filter(d => d.included).map(d => d.deliverableId) || []) as any,
          submittedBy: userId,
        },
      });

      return { vault, submission };
    });

    await this.invalidateVaultCache(vaultId, vault.clientId, userId);
    return result;
  }

  async release(
    vaultId: string,
    dto: ReleaseVaultDto,
    userId: string,
    role: string,
  ) {
    const prisma = this.prisma;
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });
    if (existing) return existing.responseBody;

    const vault = await this.prisma.vault.findUnique({
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
        data: { status: VaultStatus.RELEASED as any },
      });

      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId: vault.freelancerId!,
          vaultId: vault.id,
          type: LedgerEntryType.RELEASE,
          amount: vault.totalAmount,
          currency: 'USD',
          status: TransactionStatus.CONFIRMED,
          description: `Release for vault: ${vault.title}`,
          completedAt: new Date(),
        },
      });

      return { vault: updatedVault, ledgerEntry };
    });

    // 2. Trigger on-chain release if a vault address exists
    if (vault.vaultAddress) {
      try {
        await this.blockchainService.releaseVault(vault.vaultAddress);
      } catch (error) {
        this.logger.error(`On-chain release failed for vault ${vaultId}`, error);
        // We don't throw here to keep DB in sync, but maybe we should? 
        // For now, let's just log. The listener will eventually sync it if it succeeds later.
      }
    }

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);
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
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });
    if (existing) return existing.responseBody;

    const vault = await this.prisma.vault.findUnique({
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
          currency: 'USD',
          status: TransactionStatus.CONFIRMED,
          description: `Refund for vault: ${vault.title}`,
          completedAt: new Date(),
        },
      });

      // Store idempotency record
      await tx.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey as string,
          userId,
          endpoint: `/api/vaults/${vaultId}/refund`,
          requestHash: this.hashRequest(dto),
          responseBody: {
            success: true,
            ledgerEntry,
          } as unknown as Prisma.InputJsonValue,
          statusCode: 200,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return { success: true, ledgerEntry, vault: updatedVault };
    });

    // 2. Trigger on-chain refund if a vault address exists
    if (vault.vaultAddress) {
      try {
        await this.blockchainService.refundVault(vault.vaultAddress);
      } catch (error) {
        this.logger.error(`On-chain refund failed for vault ${vaultId}`, error);
      }
    }

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);
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
        .reduce((sum: number, le: any) => sum + le.amount, 0) || 0;

    return {
      id: vault.id,
      title: vault.title,
      description: vault.description,
      type: vault.type,
      status: vault.status,
      vaultAddress: vault.vaultAddress,
      totalAmount: vault.totalAmount,
      paidAmount,
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
    const vault = await this.prisma.vault.findUnique({
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
    const vault = await this.prisma.vault.findUnique({
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
        freelancerId: newFreelancerId,
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

    // 4. Send invitation if it's a new guest
    if (!newFreelancerId) {
      const invite = await this.invitesService.create(
        {
          vaultId: id,
          email: dto.freelancerEmail,
          expiresInDays: 7,
        },
        userId,
      );
      await this.mailsService.sendInviteEmail(
        dto.freelancerEmail,
        vault.client?.name || 'A client',
        vault.title,
        vault.totalAmount,
        invite.token,
      );
    }

    return updatedVault;
  }
}
