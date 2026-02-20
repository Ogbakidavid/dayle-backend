import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateVaultDto } from "./dto/create-vault.dto";
import { ReleaseMilestoneDto } from "./dto/release-milestone.dto";
import { RefundMilestoneDto } from "./dto/refund-milestone.dto";
import { FundVaultDto } from "./dto/fund-vault.dto";
import { UpdateVaultStatusDto } from "./dto/update-vault-status.dto";
import { PaymentRouter } from "../common/services/payment-router.service";
import {
  VaultStatus,
  MilestoneStatus,
  UserRole,
  LedgerEntryType,
  TransactionStatus,
  VerificationResult,
} from "../domain/enums";
import { StateMachine } from "../domain/state-machine";
import * as crypto from "crypto";
import { RedisService } from "../common/redis/redis.service";
import { Prisma } from "@prisma/client";

@Injectable()
export class VaultsService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private paymentRouter: PaymentRouter,
  ) {}

  async create(dto: CreateVaultDto, userId: string, role: string) {
    const prisma = this.prisma;
    const milestoneSum = dto.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (Math.abs(dto.totalAmount - milestoneSum) > 0.01) {
      throw new BadRequestException({
        code: "AMOUNT_MISMATCH",
        message: `Total amount (${dto.totalAmount}) must equal sum of milestone amounts (${milestoneSum})`,
      });
    }

    if (dto.idempotencyKey) {
      const existing = await prisma.idempotencyRecord.findUnique({
        where: { key: dto.idempotencyKey },
      });
      if (existing) return existing.responseBody;
    }

    const vault = await prisma.vault.create({
      data: {
        title: dto.title,
        description: dto.description,
        type: dto.type,
        totalAmount: dto.totalAmount,
        clientId: userId,
        status: VaultStatus.DRAFT,
        milestones: {
          create: dto.milestones.map((m) => ({
            title: m.title,
            amount: m.amount,
            dueDate: m.dueDate ? new Date(m.dueDate) : null,
            deliverableTypeId: m.deliverableTypeId,
            deliverableMode: m.deliverableMode,
            auditEnabled: m.auditEnabled ?? true,
            requirementItemsJson: (m.requirementItemsJson as unknown as Prisma.InputJsonValue) || [],
            status: MilestoneStatus.PENDING,
          })),
        },
      },
      include: {
        milestones: true,
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
    });

    if (dto.idempotencyKey) {
      await prisma.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey,
          userId,
          endpoint: "/api/vaults",
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

  private async invalidateVaultCache(vaultId: string, clientId: string, freelancerId?: string | null) {
    const keys = [
      `vaults:detail:${vaultId}`,
      `vaults:list:${UserRole.CLIENT}:${clientId}`,
    ];
    if (freelancerId) {
      keys.push(`vaults:list:${UserRole.FREELANCER}:${freelancerId}`);
    }
    await Promise.all(keys.map(key => this.redis.del(key)));
  }


  async list(userId: string, role: UserRole) {
    const prisma = this.prisma;
    const cacheKey = `vaults:list:${role}:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const where = role === UserRole.CLIENT ? { clientId: userId } : { freelancerId: userId };
    const vaults = await prisma.vault.findMany({
      where,
      include: {
        milestones: {
          include: { ledgerEntries: true },
        },
        ledgerEntries: true,
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
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
      const vault = await prisma.vault.findUnique({
        where: { id },
        include: {
          milestones: {
            include: { 
              submission: true, 
              verification: true, 
              review: true,
              ledgerEntries: true,
            },
          },
          ledgerEntries: true,
          client: { select: { id: true, name: true, email: true } },
          freelancer: { select: { id: true, name: true, email: true } },
        },
      });

      if (!vault) {
        throw new NotFoundException({ code: "VAULT_NOT_FOUND", message: "Vault not found" });
      }

      vaultResult = this.formatVault(vault);
      await this.redis.set(cacheKey, JSON.stringify(vaultResult), 3600); // 1 hour TTL
    }

    if (vaultResult.clientId !== userId && vaultResult.freelancerId !== userId) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });
    }

    return vaultResult;
  }


  async fund(id: string, dto: FundVaultDto, userId: string, role: string) {
    const prisma = this.prisma;
    const vault = await prisma.vault.findUnique({
      where: { id },
    });

    if (!vault) {
      throw new NotFoundException({ code: "VAULT_NOT_FOUND", message: "Vault not found" });
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Only client can fund" });
    }

    if (vault.status !== VaultStatus.DRAFT) {
      throw new BadRequestException({ code: "INVALID_STATE", message: "Vault not in DRAFT status" });
    }

    // Logic for funding (ledger entry, collection voucher)
    const result = await prisma.$transaction(async (tx) => {
      // Create ledger entry in PENDING status
      const providerRef = `vault_fund_${id}_${Date.now()}`;
      
      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId,
          vaultId: id,
          type: LedgerEntryType.DEPOSIT,
          amount: vault.totalAmount,
          currency: "USD",
          status: TransactionStatus.PENDING,
          description: `Funding for vault: ${vault.title}`,
          providerRef,
        },
      });

      // Payment router integration (Onramp)
      const user = await tx.user.findUnique({ where: { id: userId } });
      const onrampResult = await this.paymentRouter.initiateOnramp({
        amount: vault.totalAmount,
        currency: "USD",
        reference: providerRef,
        customerEmail: user?.email || "",
      });

      return { vault, ledgerEntry, paymentUrl: onrampResult.paymentUrl, provider: onrampResult.provider };
    });

    await this.invalidateVaultCache(id, userId, vault.freelancerId);
    return result;
  }

  async releaseMilestone(vaultId: string, dto: ReleaseMilestoneDto, userId: string, role: string) {
    const prisma = this.prisma;
    const existing = await prisma.idempotencyRecord.findUnique({ where: { key: dto.idempotencyKey } });
    if (existing) return existing.responseBody;

    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: {
        milestones: { where: { id: dto.milestoneId }, include: { verification: true } },
      },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });
    }

    const milestone = vault.milestones[0];
    if (!milestone) throw new NotFoundException({ code: "MILESTONE_NOT_FOUND", message: "Milestone not found" });

    const canRelease = StateMachine.canReleaseMilestone(
      milestone.status as MilestoneStatus,
      milestone.auditEnabled,
      milestone.verification as any,
    );

    if (!canRelease.allowed) {
      throw new BadRequestException({ code: "INVALID_STATE_TRANSITION", message: canRelease.reason });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedMilestone = await tx.milestone.update({
        where: { id: dto.milestoneId },
        data: { status: MilestoneStatus.VERIFIED },
        include: { verification: true, review: true, submission: true },
      });

      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId: vault.freelancerId!,
          vaultId: vault.id,
          milestoneId: milestone.id,
          type: LedgerEntryType.RELEASE,
          amount: milestone.amount,
          currency: "USD",
          status: TransactionStatus.CONFIRMED,
          description: `Release for milestone: ${milestone.title}`,
          completedAt: new Date(),
        },
      });

      return { milestone: updatedMilestone, ledgerEntry };
    });

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);
    return result;
  }

  async refund(vaultId: string, dto: RefundMilestoneDto, userId: string, role: string) {
    const prisma = this.prisma;
    // Check idempotency
    const existing = await prisma.idempotencyRecord.findUnique({ where: { key: dto.idempotencyKey } });
    if (existing) return existing.responseBody;

    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: {
        milestones: { where: { id: dto.milestoneId } },
      },
    });

    if (!vault || vault.clientId !== userId) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });
    }

    const milestone = vault.milestones[0];
    if (!milestone) {
      throw new NotFoundException({ code: "MILESTONE_NOT_FOUND", message: "Milestone not found" });
    }

    // Validate milestone is in REJECTED status
    if (milestone.status !== MilestoneStatus.REJECTED) {
      throw new BadRequestException({
        code: "INVALID_STATE",
        message: "Can only refund rejected milestones",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Create refund ledger entry
      const ledgerEntry = await tx.ledgerEntry.create({
        data: {
          userId,
          vaultId: vault.id,
          milestoneId: milestone.id,
          type: LedgerEntryType.REFUND,
          amount: milestone.amount,
          currency: "USD",
          status: TransactionStatus.CONFIRMED,
          description: `Refund for rejected milestone: ${milestone.title}`,
          completedAt: new Date(),
        },
      });

      // Store idempotency record
      await tx.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey,
          userId,
          endpoint: `/api/vaults/${vaultId}/refund`,
          requestHash: this.hashRequest(dto),
          responseBody: { success: true, ledgerEntry } as unknown as Prisma.InputJsonValue,
          statusCode: 200,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      return { success: true, ledgerEntry };
    });

    await this.invalidateVaultCache(vaultId, userId, vault.freelancerId);
    return result;
  }

  async updateStatus(id: string, dto: UpdateVaultStatusDto, userId: string, role: string) {
    const prisma = this.prisma;
    const vault = await prisma.vault.findUnique({ where: { id } });
    if (!vault) throw new NotFoundException({ code: "VAULT_NOT_FOUND", message: "Vault not found" });
    if (vault.clientId !== userId) throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });

    const updatedVault = await prisma.vault.update({
      where: { id },
      data: { status: dto.status as any },
    });

    await this.invalidateVaultCache(id, userId, updatedVault.freelancerId);
    return this.formatVault(updatedVault);
  }

  private formatVault(vault: any) {
    const paidAmount = vault.ledgerEntries
      ?.filter((le: any) => le.type === LedgerEntryType.RELEASE && le.status === TransactionStatus.CONFIRMED)
      .reduce((sum: number, le: any) => sum + le.amount, 0) || 0;

    return {
      id: vault.id,
      title: vault.title,
      description: vault.description,
      type: vault.type,
      status: vault.status,
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
      milestones: vault.milestones?.map((m: any) => this.formatMilestone(m)) || [],
    };
  }

  private formatMilestone(milestone: any) {
    const releaseEntry = milestone.ledgerEntries?.find((le: any) => le.type === LedgerEntryType.RELEASE);
    const refundEntry = milestone.ledgerEntries?.find((le: any) => le.type === LedgerEntryType.REFUND);

    return {
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      amount: milestone.amount,
      dueDate: milestone.dueDate?.toISOString(),
      deliverableTypeId: milestone.deliverableTypeId,
      deliverableMode: milestone.deliverableMode,
      auditEnabled: milestone.auditEnabled,
      requirementItemsJson: milestone.requirementItemsJson,
      submission: milestone.submission,
      verification: milestone.verification,
      review: milestone.review,
      releaseStatus: releaseEntry ? releaseEntry.status : "NOT_STARTED",
      refundStatus: refundEntry ? refundEntry.status : null,
    };
  }

  private hashRequest(data: any): string {
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
  }
}