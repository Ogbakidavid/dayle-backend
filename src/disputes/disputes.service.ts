import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDisputeDto } from "./dto/create-dispute.dto";
import { DisputeStatus, UserRole, VaultStatus } from "../domain/enums";

@Injectable()
export class DisputesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, role: UserRole, dto: CreateDisputeDto) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: dto.vaultId },
    });

    if (!vault) throw new NotFoundException("Vault not found");
    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException("Not authorized");
    }

    const dispute = await this.prisma.$transaction(async (tx) => {
      // 1. Update Vault Status
      await tx.vault.update({
        where: { id: dto.vaultId },
        data: { status: VaultStatus.DISPUTED as any },
      });

      // 2. Create Dispute
      const newDispute = await tx.dispute.create({
        data: {
          vaultId: dto.vaultId,
          milestoneId: dto.milestoneId,
          requirementRef: dto.requirementRef,
          disputeType: dto.disputeType,
          reasonCode: dto.reasonCode,
          openedByUserId: userId,
          openedByRole: role,
          status: DisputeStatus.OPEN,
          description: dto.description,
        },
        include: { events: true },
      });

      // 3. Log initial event
      await tx.disputeEvent.create({
        data: {
          disputeId: newDispute.id,
          actorId: userId,
          actorRole: role,
          eventType: "OPENED",
          payload: { reasonCode: dto.reasonCode, requirementRef: dto.requirementRef },
        },
      });

      return newDispute;
    });

    return dispute;
  }

  async list(userId: string, status?: DisputeStatus, vaultId?: string, limit: number = 50, offset: number = 0) {
    const where: any = {
      vault: {
        OR: [{ clientId: userId }, { freelancerId: userId }],
      },
    };
    if (status) where.status = status;
    if (vaultId) where.vaultId = vaultId;

    const [disputes, total] = await Promise.all([
      this.prisma.dispute.findMany({
        where,
        take: +limit,
        skip: +offset,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return { disputes, total, limit: +limit, offset: +offset };
  }

  async getById(id: string, userId: string, role?: UserRole) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: { events: true, vault: true },
    });

    if (!dispute) throw new NotFoundException("Dispute not found");

    // Allow Admins or participants
    const isParticipant = dispute.vault.clientId === userId || dispute.vault.freelancerId === userId;
    const isAdmin = role === UserRole.ADMIN;

    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException("Not authorized");
    }

    return dispute;
  }
}
