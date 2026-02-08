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
import { Prisma } from "@prisma/client";

@Injectable()
export class VaultsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateVaultDto, userId: string) {
    const milestoneSum = dto.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (Math.abs(dto.totalAmount - milestoneSum) > 0.01) {
      throw new BadRequestException({
        code: "AMOUNT_MISMATCH",
        message: `Total amount (${dto.totalAmount}) must equal sum of milestone amounts (${milestoneSum})`,
      });
    }

    if (dto.idempotencyKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { key: dto.idempotencyKey },
      });
      if (existing) return existing.responseBody;
    }

    const vault = await this.prisma.vault.create({
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
      await this.prisma.idempotencyRecord.create({
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

    return this.formatVault(vault);
  }

  async list(userId: string, role: UserRole) {
    const where = role === UserRole.CLIENT ? { clientId: userId } : { freelancerId: userId };
    const vaults = await this.prisma.vault.findMany({
      where,
      include: {
        milestones: true,
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      vaults: vaults.map((v) => this.formatVault(v)),
      total: vaults.length,
    };
  }

  async getById(id: string, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id },
      include: {
        milestones: {
          include: { submission: true, verification: true, review: true },
        },
        client: { select: { id: true, name: true, email: true } },
        freelancer: { select: { id: true, name: true, email: true } },
      },
    });

    if (!vault) {
      throw new NotFoundException({ code: "VAULT_NOT_FOUND", message: "Vault not found" });
    }

    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });
    }

    return this.formatVault(vault);
  }

  async fund(id: string, dto: FundVaultDto, userId: string) {
    const vault = await this.prisma.vault.findUnique({
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

    // Logic for funding (ledger entry, status update)
    const result = await this.prisma.$transaction(async (tx) => {
      const updatedVault = await tx.vault.update({
        where: { id },
        data: { status: vault.freelancerId ? VaultStatus.ACTIVE : VaultStatus.FUNDED_UNASSIGNED },
      });

      await tx.ledgerEntry.create({
        data: {
          userId,
          vaultId: id,
          type: LedgerEntryType.DEPOSIT,
          amount: vault.totalAmount,
          currency: "USD",
          status: TransactionStatus.CONFIRMED,
          description: `Funding for vault: ${vault.title}`,
        },
      });

      return updatedVault;
    });

    return this.formatVault(result);
  }

  async releaseMilestone(vaultId: string, dto: ReleaseMilestoneDto, userId: string) {
    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key: dto.idempotencyKey } });
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

    const result = await this.prisma.$transaction(async (tx) => {
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

    return result;
  }

  async refund(vaultId: string, dto: RefundMilestoneDto, userId: string) {
    // Check idempotency
    const existing = await this.prisma.idempotencyRecord.findUnique({ where: { key: dto.idempotencyKey } });
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

    const result = await this.prisma.$transaction(async (tx) => {
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

    return result;
  }

  async updateStatus(id: string, dto: UpdateVaultStatusDto, userId: string) {
    const vault = await this.prisma.vault.findUnique({ where: { id } });
    if (!vault) throw new NotFoundException({ code: "VAULT_NOT_FOUND", message: "Vault not found" });
    if (vault.clientId !== userId) throw new ForbiddenException({ code: "UNAUTHORIZED", message: "Not authorized" });

    const updatedVault = await this.prisma.vault.update({
      where: { id },
      data: { status: dto.status as any },
    });

    return this.formatVault(updatedVault);
  }

  private formatVault(vault: any) {
    return {
      id: vault.id,
      title: vault.title,
      description: vault.description,
      type: vault.type,
      status: vault.status,
      totalAmount: vault.totalAmount,
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
    };
  }

  private hashRequest(data: any): string {
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
  }
}