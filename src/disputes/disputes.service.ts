import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';

import { CreateDisputeDto } from './dto/create-dispute.dto';
import {
  ResolveDisputeDto,
  DisputeResolutionOutcome,
} from './dto/resolve-dispute.dto';
import {
  DisputeStatus,
  UserRole,
  VaultStatus,
  LedgerEntryType,
  TransactionStatus,
} from '../domain/enums';
import { ethers } from 'ethers';

@Injectable()
export class DisputesService {
  constructor(
    private prisma: PrismaService,
    private blockchainService: BlockchainService,
  ) {}

  async create(userId: string, role: UserRole, dto: CreateDisputeDto) {
    const prisma = this.prisma;
    const vault = await (prisma.vault.findUnique as any)({
      where: { id: dto.vaultId },
      include: { deliverables: true },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException('Not authorized');
    }

    if (vault.status === VaultStatus.RELEASED) {
      throw new BadRequestException('Cannot raise a dispute on a released vault');
    }

    // Lookup deliverable ID by title from vault deliverables
    let deliverableId: string | null = null;
    let frozenTitle: string | null = null;

    if (dto.deliverableTitle && vault.deliverables) {
      const deliverables = vault.deliverables as any[];
      const matchedDeliverable = deliverables.find(
        (d) => d.title.toLowerCase() === dto.deliverableTitle?.toLowerCase(),
      );

      if (matchedDeliverable) {
        deliverableId = matchedDeliverable.id;
        frozenTitle = matchedDeliverable.title; // Store the official title
      } else {
        frozenTitle = dto.deliverableTitle; // Fallback to provided title
      }
    }

    const dispute = await prisma.$transaction(async (tx) => {
      // 1. Update Vault Status
      await tx.vault.update({
        where: { id: dto.vaultId },
        data: { status: VaultStatus.DISPUTED as any },
      });

      // 2. Create Dispute
      const newDispute = await tx.dispute.create({
        data: {
          vaultId: dto.vaultId,
          deliverableId: deliverableId,
          deliverableTitle: frozenTitle,
          disputeType: dto.disputeType,
          reasonCode: dto.reasonCode,
          openedByUserId: userId,
          openedByRole: role,
          status: DisputeStatus.OPEN as any,
          description: dto.description,
        } as any,
        include: { events: true },
      });

      // 3. Log initial event
      await tx.disputeEvent.create({
        data: {
          disputeId: newDispute.id,
          actorId: userId,
          actorRole: role,
          eventType: 'OPENED',
          payload: {
            reasonCode: dto.reasonCode,
            deliverableId,
            deliverableTitle: frozenTitle,
          },
        },
      });

      return newDispute;
    });

    return dispute;
  }

  async list(
    userId: string,
    role: UserRole,
    status?: DisputeStatus,
    vaultId?: string,
    limit: number = 50,
    offset: number = 0,
  ) {
    const prisma = this.prisma;
    const where: any = {
      vault: {
        OR: [{ clientId: userId }, { freelancerId: userId }],
      },
    };
    if (status) where.status = status;
    if (vaultId) where.vaultId = vaultId;

    const [disputes, total] = await Promise.all([
      prisma.dispute.findMany({
        where,
        take: +limit,
        skip: +offset,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.dispute.count({ where }),
    ]);

    return { disputes, total, limit: +limit, offset: +offset };
  }

  async getById(id: string, userId: string, role?: UserRole) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { events: true, vault: true },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');

    // Allow Admins or participants
    const isParticipant =
      dispute.vault.clientId === userId ||
      dispute.vault.freelancerId === userId;
    const isAdmin = role === UserRole.ADMIN;

    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('Not authorized');
    }

    return dispute;
  }

  async resolve(
    id: string,
    adminId: string,
    role: string,
    dto: ResolveDisputeDto,
  ) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');

    // Only Admins can resolve
    const admin = await prisma.user.findUnique({ where: { id: adminId } });
    if (!admin || admin.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can resolve disputes');
    }

    if (
      dispute.status === DisputeStatus.RESOLVED ||
      dispute.status === DisputeStatus.REJECTED
    ) {
      throw new BadRequestException('Dispute is already closed');
    }

    const { outcome, splitAmount, notes } = dto;
    const amount = dispute.vault.totalAmount;

    const resolution = await prisma.$transaction(async (tx) => {
      // 1. Create Ledger Entries based on outcome
      if (outcome === DisputeResolutionOutcome.RELEASE) {
        await tx.ledgerEntry.create({
          data: {
            userId: dispute.vault.freelancerId!,
            vaultId: dispute.vaultId,
            type: LedgerEntryType.RELEASE,
            amount,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution RELEASE: ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        await tx.vault.update({
          where: { id: dispute.vaultId },
          data: { status: VaultStatus.RELEASED as any },
        });

        // TRIGGER ON-CHAIN RELEASE
        if (dispute.vault.vaultAddress) {
          await this.blockchainService.releaseVault(dispute.vault.vaultAddress);
        }
      } else if (outcome === DisputeResolutionOutcome.REFUND) {
        await tx.ledgerEntry.create({
          data: {
            userId: dispute.vault.clientId,
            vaultId: dispute.vaultId,
            type: LedgerEntryType.REFUND,
            amount,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution REFUND: ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        await tx.vault.update({
          where: { id: dispute.vaultId },
          data: { status: VaultStatus.REFUNDED as any },
        });

        // TRIGGER ON-CHAIN REFUND
        if (dispute.vault.vaultAddress) {
          await this.blockchainService.refundVault(dispute.vault.vaultAddress);
        }
      } else if (outcome === DisputeResolutionOutcome.SPLIT) {

        const decimals = (dispute.vault as any).tokenDecimals || 18;

        const splitAmountBigInt = ethers.parseUnits(
          splitAmount!.toString(), 
          decimals
        );

        const vaultAmount = BigInt(amount);

        if (splitAmountBigInt <= 0n || splitAmountBigInt > vaultAmount) {
          throw new BadRequestException('Invalid split amount');
        }

        const refundAmount = vaultAmount - splitAmountBigInt;

        // Release splitAmount to freelancer
        await tx.ledgerEntry.create({
          data: {
            userId: dispute.vault.freelancerId!,
            vaultId: dispute.vaultId,
            type: LedgerEntryType.RELEASE,
            amount: splitAmountBigInt,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution SPLIT (Release): ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        // Refund the rest to client
        await tx.ledgerEntry.create({
          data: {
            userId: dispute.vault.clientId,
            vaultId: dispute.vaultId,
            type: LedgerEntryType.REFUND,
            amount: refundAmount,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution SPLIT (Refund): ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        // Mark vault as released as it is fully processed
        await tx.vault.update({
          where: { id: dispute.vaultId },
          data: { status: VaultStatus.RELEASED as any },
        });
      }

      // 2. Update Dispute
      const updatedDispute = await tx.dispute.update({
        where: { id },
        data: {
          status: DisputeStatus.RESOLVED,
          resolution: notes,
          resolvedAt: new Date(),
        },
      });

      // 3. Log Event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          actorId: adminId,
          actorRole: UserRole.ADMIN,
          eventType: 'RESOLVED',
          payload: { outcome, splitAmount, notes },
        },
      });

      return updatedDispute;
    });

    return resolution;
  }
}
