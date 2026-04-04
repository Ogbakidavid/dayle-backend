import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailsService } from '../notifications/mails.service';

import { CreateDisputeDto } from './dto/create-dispute.dto';
import {
  ResolveDisputeDto,
  DisputeResolutionOutcome,
} from './dto/resolve-dispute.dto';
// ... (imports remain same)
import {
  DisputeStatus,
  UserRole,
  VaultStatus,
  LedgerEntryType,
  TransactionStatus,
  KycStatus,
} from '../domain/enums';
import { ethers } from 'ethers';
import { calculateDayleFee } from '../common/utils/fee.utils';

@Injectable()
export class DisputesService {
  constructor(
    private prisma: PrismaService,
    private blockchainService: BlockchainService,
    private notificationsService: NotificationsService,
    private mailsService: MailsService,
  ) {}

  private calculateNewExpiry(dispute: any): Date {
    const now = Date.now();
    const fortyEightHours = 48 * 60 * 60 * 1000;
    const ninetySixHours = 96 * 60 * 60 * 1000;

    const createdAt = new Date(dispute.createdAt).getTime();
    const maxExpiry = createdAt + ninetySixHours;
    const proposedExpiry = now + fortyEightHours;

    return new Date(Math.min(proposedExpiry, maxExpiry));
  }

  private async escalateToPhase2(id: string, tx: any) {
    await tx.dispute.update({
      where: { id },
      data: { status: DisputeStatus.UNDER_REVIEW as any },
    });

    await tx.disputeEvent.create({
      data: {
        disputeId: id,
        eventType: 'ESCALATED',
        payload: {
          reason: '96-hour limit exceeded',
        },
      },
    });

    // Notify parties
    const dispute = await tx.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    const msg =
      'The mutual resolution window has closed. Your dispute is now under platform review.';
    await this.notificationsService.createNotification(dispute.vault.clientId, {
      type: 'dispute',
      title: 'Dispute Escalated',
      message: msg,
      action: `/client/dispute/${id}`,
    });
    if (dispute.vault.freelancerId) {
      await this.notificationsService.createNotification(
        dispute.vault.freelancerId,
        {
          type: 'dispute',
          title: 'Dispute Escalated',
          message: msg,
          action: `/freelancer/dispute/${id}`,
        },
      );
    }
  }

  // ... (create, list, getById, investigate methods)

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

    // Tier 2 KYC Enforcement for Disputes
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Full identity verification (Didit) is required to initiate a dispute.',
      );
    }

    if (vault.status === VaultStatus.RELEASED) {
      throw new BadRequestException(
        'Cannot raise a dispute on a released vault',
      );
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
      const resolutionWindow = 48 * 60 * 60 * 1000; // 48 hours
      const expiresAt = new Date(Date.now() + resolutionWindow);

      const newDispute = await tx.dispute.create({
        data: {
          vaultId: dto.vaultId,
          deliverableId: deliverableId,
          deliverableTitle: frozenTitle,
          disputeType: dto.disputeType,
          reasonCode: dto.reasonCode,
          openedByUserId: userId,
          openedByRole: role,
          status: DisputeStatus.MUTUAL_RESOLUTION as any,
          description: dto.description,
          resolutionWindowExpiresAt: expiresAt,
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

      // 4. Create Evidence records if any
      if (dto.evidence && dto.evidence.length > 0) {
        for (const item of dto.evidence) {
          await tx.evidence.create({
            data: {
              vaultId: dto.vaultId,
              disputeId: newDispute.id,
              type: 'MESSAGE' as any, // Default type for initial evidence
              payload: {
                fileName: item.filename,
                key: item.key,
                size: item.size,
                type: item.type,
                purpose: 'DISPUTE_EVIDENCE',
              } as any,
              createdBy: userId,
              immutableAfterSubmission: true,
            },
          });
        }
      }

      return newDispute;
    });

    // 5. Send email notification to the other party
    const otherPartyId = userId === vault.clientId ? vault.freelancerId : vault.clientId;
    if (otherPartyId) {
      const otherUser = await this.prisma.user.findUnique({ where: { id: otherPartyId } });
      const openingUser = await this.prisma.user.findUnique({ where: { id: userId } });
      if (otherUser) {
        await this.mailsService.sendVaultStatusEmail(
          otherUser.email,
          otherUser.name || 'User',
          vault.title,
          'dispute_raised',
          `/${userId === vault.clientId ? 'freelancer' : 'client'}/dispute/${dispute.id}`,
          openingUser?.name || 'The other party',
        );
      }
    }

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
      include: {
        events: true,
        vault: {
          include: {
            deliverables: true,
            submissions: {
              include: { deliverables: true },
              orderBy: { submittedAt: 'desc' },
            },
          },
        },
        openedBy: true,
      },
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

  async investigate(id: string, adminId: string) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');

    if (dispute.status !== DisputeStatus.OPEN) {
      return dispute; // Already investigating or resolved
    }

    const updatedDispute = await prisma.$transaction(async (tx) => {
      // 1. Update Dispute Status
      const updated = await tx.dispute.update({
        where: { id },
        data: { status: DisputeStatus.UNDER_REVIEW as any },
      });

      // 2. Log Event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          actorId: adminId,
          actorRole: UserRole.ADMIN,
          eventType: 'UNDER_REVIEW',
          payload: {
            notes: 'Investigation started by admin',
          },
        },
      });

      return updated;
    });

    return updatedDispute;
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

    if (!adminId) {
      throw new UnauthorizedException('Admin ID is missing from request');
    }

    // Only Admins can resolve (Checking both User table for social admins and Admin table for dashboard admins)
    let isAuthorized = false;
    const userAdmin = await prisma.user.findUnique({
      where: { id: adminId },
      select: { role: true },
    });

    if (userAdmin && userAdmin.role === UserRole.ADMIN) {
      isAuthorized = true;
    } else {
      const explicitAdmin = await prisma.admin.findUnique({
        where: { id: adminId },
      });
      if (explicitAdmin) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
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
          const vaultAmountUSD = parseFloat(
            ethers.formatUnits(
              dispute.vault.totalAmount || BigInt(0),
              dispute.vault.tokenDecimals || 6,
            ),
          );
          const fees = calculateDayleFee(vaultAmountUSD);

          await this.blockchainService.releaseVault(
            dispute.vault.vaultAddress,
            fees.totalFeeBasisPoints,
          );
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
        const vaultAmountBigInt = BigInt(dispute.vault.totalAmount);
        const splitAmountBigInt = ethers.parseUnits(
          splitAmount!.toString(),
          decimals,
        );

        if (splitAmountBigInt <= 0n || splitAmountBigInt > vaultAmountBigInt) {
          throw new BadRequestException('Invalid split amount');
        }

        // Use tiered fee logic
        const vaultAmountUSD = parseFloat(
          ethers.formatUnits(vaultAmountBigInt || BigInt(0), decimals),
        );
        const fees = calculateDayleFee(vaultAmountUSD);

        const treasuryAmountBigInt =
          (vaultAmountBigInt * BigInt(fees.totalFeeBasisPoints)) / 10000n;

        const availableForSplit = vaultAmountBigInt - treasuryAmountBigInt;

        // Ensure freelancer split doesn't exceed available after fee
        const freelancerAmountBigInt =
          splitAmountBigInt > availableForSplit
            ? availableForSplit
            : splitAmountBigInt;
        const clientAmountBigInt =
          vaultAmountBigInt - freelancerAmountBigInt - treasuryAmountBigInt;

        // Release splitAmount to freelancer
        await tx.ledgerEntry.create({
          data: {
            userId: dispute.vault.freelancerId!,
            vaultId: dispute.vaultId,
            type: LedgerEntryType.RELEASE,
            amount: freelancerAmountBigInt,
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
            amount: clientAmountBigInt,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution SPLIT (Refund): ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        // Log Fee
        await tx.ledgerEntry.create({
          data: {
            userId: adminId, // Routing to treasury conceptually
            vaultId: dispute.vaultId,
            type: LedgerEntryType.FEE,
            amount: treasuryAmountBigInt,
            status: TransactionStatus.CONFIRMED,
            description: `Dispute Resolution SPLIT (Fee): ${notes}`,
            disputeId: id,
            completedAt: new Date(),
          },
        });

        // Mark vault as released as it is fully processed
        await tx.vault.update({
          where: { id: dispute.vaultId },
          data: { status: VaultStatus.RELEASED as any },
        });

        // TRIGGER ON-CHAIN SETTLE
        if (dispute.vault.vaultAddress) {
          await this.blockchainService.settleVault(
            dispute.vault.vaultAddress,
            freelancerAmountBigInt,
            clientAmountBigInt,
            treasuryAmountBigInt,
          );
        }
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
  async proposeSettlement(
    id: string,
    userId: string,
    dto: { amountToFreelancer: number; notes: string },
  ) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');
    if ((dispute.status as any) !== DisputeStatus.MUTUAL_RESOLUTION) {
      throw new BadRequestException(
        'Can only propose settlement during mutual resolution phase',
      );
    }

    const isParticipant =
      dispute.vault.clientId === userId ||
      dispute.vault.freelancerId === userId;
    if (!isParticipant) throw new ForbiddenException('Not authorized');

    // Tier 2 KYC Enforcement
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Full identity verification (Didit) is required to propose a settlement.',
      );
    }

    const updatedDispute = await prisma.$transaction(async (tx) => {
      // 1. Check for 96-hour cap
      const elapsed = Date.now() - new Date(dispute.createdAt).getTime();
      if (elapsed >= 96 * 60 * 60 * 1000) {
        await this.escalateToPhase2(id, tx);
        throw new BadRequestException(
          'The mutual resolution window has closed. Your dispute is now under platform review.',
        );
      }

      // Split Validation (10% - 90%)
      const decimals = (dispute.vault as any).tokenDecimals || 18;
      const vaultAmountBigInt = BigInt(dispute.vault.totalAmount);

      // Calculate 10% and 90% boundaries accurately using BigInt
      const tenPercentLimit = vaultAmountBigInt / 10n;
      const ninetyPercentLimit = (vaultAmountBigInt * 9n) / 10n;

      // Convert proposed amount to BigInt for comparison
      const proposedBigInt = ethers.parseUnits(
        dto.amountToFreelancer.toString(),
        decimals,
      );

      if (
        proposedBigInt < tenPercentLimit ||
        proposedBigInt > ninetyPercentLimit
      ) {
        throw new BadRequestException(
          'For full refund or full release, please use the dedicated buttons.',
        );
      }

      // 2. Reset Timer
      const newExpiry = this.calculateNewExpiry(dispute);
      await tx.dispute.update({
        where: { id },
        data: { resolutionWindowExpiresAt: newExpiry },
      });

      // 3. Log Propose Event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          actorId: userId,
          eventType: 'SETTLEMENT_PROPOSED',
          payload: {
            amountToFreelancer: dto.amountToFreelancer,
            notes: dto.notes,
          },
        },
      });

      // 4. Send Notifications
      const msg = 'New offer received — the 48-hour window has been reset.';
      const otherPartyId =
        userId === dispute.vault.clientId
          ? dispute.vault.freelancerId
          : dispute.vault.clientId;
      if (otherPartyId) {
        await this.notificationsService.createNotification(otherPartyId, {
          type: 'dispute',
          title: 'New Offer Received',
          message: msg,
          action: `/${userId === dispute.vault.clientId ? 'freelancer' : 'client'}/dispute/${id}`,
        });
      }

      return dispute;
    });

    return updatedDispute;
  }

  async requestTotalRefund(id: string, userId: string, notes: string) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');
    if ((dispute.status as any) !== DisputeStatus.MUTUAL_RESOLUTION) {
      throw new BadRequestException(
        'Can only propose settlement during mutual resolution phase',
      );
    }

    const isParticipant =
      dispute.vault.clientId === userId ||
      dispute.vault.freelancerId === userId;
    if (!isParticipant) throw new ForbiddenException('Not authorized');

    // Tier 2 KYC Enforcement
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Full identity verification (Didit) is required to request a refund.',
      );
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Check for 96-hour cap
      const elapsed = Date.now() - new Date(dispute.createdAt).getTime();
      if (elapsed >= 96 * 60 * 60 * 1000) {
        await this.escalateToPhase2(id, tx);
        throw new BadRequestException(
          'The mutual resolution window has closed. Your dispute is now under platform review.',
        );
      }

      // 2. Reset Timer
      const newExpiry = this.calculateNewExpiry(dispute);
      await tx.dispute.update({
        where: { id },
        data: { resolutionWindowExpiresAt: newExpiry },
      });

      // 3. Log Event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          actorId: userId,
          eventType: 'TOTAL_REFUND_REQUESTED',
          payload: { notes },
        },
      });

      // 4. Notifications
      const msg = 'New offer received — the 48-hour window has been reset.';
      const otherPartyId =
        userId === dispute.vault.clientId
          ? dispute.vault.freelancerId
          : dispute.vault.clientId;
      if (otherPartyId) {
        await this.notificationsService.createNotification(otherPartyId, {
          type: 'dispute',
          title: 'Total Refund Requested',
          message: msg,
          action: `/${userId === dispute.vault.clientId ? 'freelancer' : 'client'}/dispute/${id}`,
        });
      }

      return dispute;
    });
  }

  async requestTotalRelease(id: string, userId: string, notes: string) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');
    if ((dispute.status as any) !== DisputeStatus.MUTUAL_RESOLUTION) {
      throw new BadRequestException(
        'Can only propose settlement during mutual resolution phase',
      );
    }

    const isParticipant =
      dispute.vault.clientId === userId ||
      dispute.vault.freelancerId === userId;
    if (!isParticipant) throw new ForbiddenException('Not authorized');

    // Tier 2 KYC Enforcement
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Full identity verification (Didit) is required to request a release.',
      );
    }

    return await prisma.$transaction(async (tx) => {
      // 1. Check for 96-hour cap
      const elapsed = Date.now() - new Date(dispute.createdAt).getTime();
      if (elapsed >= 96 * 60 * 60 * 1000) {
        await this.escalateToPhase2(id, tx);
        throw new BadRequestException(
          'The mutual resolution window has closed. Your dispute is now under platform review.',
        );
      }

      // 2. Reset Timer
      const newExpiry = this.calculateNewExpiry(dispute);
      await tx.dispute.update({
        where: { id },
        data: { resolutionWindowExpiresAt: newExpiry },
      });

      // 3. Log Event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          actorId: userId,
          eventType: 'TOTAL_RELEASE_REQUESTED',
          payload: { notes },
        },
      });

      // 4. Notifications
      const msg = 'New offer received — the 48-hour window has been reset.';
      const otherPartyId =
        userId === dispute.vault.clientId
          ? dispute.vault.freelancerId
          : dispute.vault.clientId;
      if (otherPartyId) {
        await this.notificationsService.createNotification(otherPartyId, {
          type: 'dispute',
          title: 'Total Release Requested',
          message: msg,
          action: `/${userId === dispute.vault.clientId ? 'freelancer' : 'client'}/dispute/${id}`,
        });
      }

      return dispute;
    });
  }

  async acceptSettlement(id: string, userId: string) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true, events: { orderBy: { createdAt: 'desc' } } },
    });

    if (!dispute) throw new NotFoundException('Dispute not found');
    if ((dispute.status as any) !== DisputeStatus.MUTUAL_RESOLUTION) {
      throw new BadRequestException('No active mutual resolution phase');
    }

    // Find latest proposal
    const lastProposal = dispute.events.find(
      (e) => e.eventType === 'SETTLEMENT_PROPOSED',
    );
    if (!lastProposal)
      throw new BadRequestException('No settlement proposal found');

    const proposalActorId = lastProposal.actorId;
    if (proposalActorId === userId) {
      throw new BadRequestException('You cannot accept your own proposal');
    }

    const isParticipant =
      dispute.vault.clientId === userId ||
      dispute.vault.freelancerId === userId;
    if (!isParticipant) throw new ForbiddenException('Not authorized');

    // Tier 2 KYC Enforcement
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException(
        'Full identity verification (Didit) is required to accept a settlement.',
      );
    }

    const { amountToFreelancer, notes } = lastProposal.payload as any;

    // Split Validation (10% - 90%) - Secondary safety check
    const decimals = (dispute.vault as any).tokenDecimals || 18;
    const vaultAmountBigInt = BigInt(dispute.vault.totalAmount);
    const tenPercentLimit = vaultAmountBigInt / 10n;
    const ninetyPercentLimit = (vaultAmountBigInt * 9n) / 10n;
    const proposedBigInt = ethers.parseUnits(
      amountToFreelancer.toString(),
      decimals,
    );

    if (
      proposedBigInt < tenPercentLimit ||
      proposedBigInt > ninetyPercentLimit
    ) {
      throw new BadRequestException(
        'For full refund or full release, please use the dedicated buttons.',
      );
    }

    // Trigger resolve logic but as participants
    return this.resolve(id, userId, 'PARTICIPANT', {
      outcome: DisputeResolutionOutcome.SPLIT,
      splitAmount: amountToFreelancer,
      notes: `Accepted Mutual Resolution: ${notes}`,
    });
  }
}
