import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateVaultDto } from "./dto/create-vault.dto";
import { ReleaseMilestoneDto } from "./dto/release-milestone.dto";
import {
  VaultStatus,
  MilestoneStatus,
  UserRole,
  LedgerEntryType,
  TransactionStatus,
} from "../domain/enums";
import { StateMachine } from "../domain/state-machine";
import * as crypto from "crypto";
import { Prisma } from "@prisma/client";


@Injectable()
export class VaultsService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateVaultDto, userId: string) {
    // Validate total amount matches milestone sum
    const milestoneSum = dto.milestones.reduce((sum, m) => sum + m.amount, 0);
    if (Math.abs(dto.totalAmount - milestoneSum) > 0.01) {
      throw new BadRequestException({
        code: "AMOUNT_MISMATCH",
        message: `Total amount (${dto.totalAmount}) must equal sum of milestone amounts (${milestoneSum})`,
      });
    }

    // Check idempotency
    if (dto.idempotencyKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { key: dto.idempotencyKey },
      });

      if (existing) {
        return existing.responseBody;
      }
    }

    // Create vault with milestones
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
        client: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Store idempotency record
    if (dto.idempotencyKey) {
      await this.prisma.idempotencyRecord.create({
        data: {
          key: dto.idempotencyKey,
          userId,
          endpoint: "/api/vaults",
          requestHash: this.hashRequest(dto),
          responseBody: vault,
          statusCode: 201,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        },
      });
    }

    return this.formatVault(vault);
  }

  async list(userId: string, role: UserRole) {
    const where =
      role === UserRole.CLIENT
        ? { clientId: userId }
        : { freelancerId: userId };

    const vaults = await this.prisma.vault.findMany({
      where,
      include: {
        milestones: true,
        client: { select: { id: true, name: true } },
        freelancer: { select: { id: true, name: true } },
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
          include: {
            submission: true,
            verification: true,
            review: true,
          },
        },
        client: { select: { id: true, name: true } },
        freelancer: { select: { id: true, name: true } },
      },
    });

    if (!vault) {
      throw new NotFoundException({
        code: "VAULT_NOT_FOUND",
        message: "Vault not found",
      });
    }

    // Check authorization
    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException({
        code: "UNAUTHORIZED",
        message: "You are not authorized to view this vault",
      });
    }

    return this.formatVault(vault);
  }

  async releaseMilestone(
    vaultId: string,
    dto: ReleaseMilestoneDto,
    userId: string,
  ) {
    // Check idempotency
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key: dto.idempotencyKey },
    });

    if (existing) {
      return existing.responseBody;
    }

    // Get vault and milestone
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
      include: {
        milestones: {
          where: { id: dto.milestoneId },
          include: { verification: true },
        },
      },
    });

    if (!vault) {
      throw new NotFoundException({
        code: "VAULT_NOT_FOUND",
        message: "Vault not found",
      });
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException({
        code: "UNAUTHORIZED",
        message: "Only vault client can release milestones",
      });
    }

    const milestone = vault.milestones[0];
    if (!milestone) {
      throw new NotFoundException({
        code: "MILESTONE_NOT_FOUND",
        message: "Milestone not found",
      });
    }

    // State machine validation
    const canRelease = StateMachine.canReleaseMilestone(
      milestone.status as MilestoneStatus,
      milestone.auditEnabled,
      milestone.verification as any,
    );

    if (!canRelease.allowed) {
      throw new BadRequestException({
        code: "INVALID_STATE_TRANSITION",
        message: canRelease.reason,
      });
    }

    // Execute release in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Update milestone status
      const updatedMilestone = await tx.milestone.update({
        where: { id: dto.milestoneId },
        data: { status: MilestoneStatus.VERIFIED },
        include: { verification: true, review: true, submission: true },
      });

      // Create RELEASE ledger entry
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

    // Store idempotency record
    await this.prisma.idempotencyRecord.create({
      data: {
        key: dto.idempotencyKey,
        userId,
        endpoint: `/api/vaults/${vaultId}/release-milestone`,
        requestHash: this.hashRequest(dto),
        responseBody: result,
        statusCode: 200,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return result;
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
      escrowRef: vault.escrowRef, // Hidden from UI
      createdAt: vault.createdAt.toISOString(),
      milestones:
        vault.milestones?.map((m: any) => this.formatMilestone(m)) || [],
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
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(data))
      .digest("hex");
  }
}