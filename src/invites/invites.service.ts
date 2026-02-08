import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateInviteDto } from "./dto/create-invite.dto";
import { RespondInviteDto } from "./dto/respond-invite.dto";
import { InviteStatus, VaultStatus, UserRole } from "../domain/enums";
import * as crypto from "crypto";

@Injectable()
export class InvitesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateInviteDto, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: dto.vaultId },
    });

    if (!vault) {
      throw new NotFoundException("Vault not found");
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException("Only vault client can invite");
    }

    if (vault.freelancerId) {
      throw new BadRequestException("Vault already has a freelancer");
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (dto.expiresInDays || 7));

    const invite = await this.prisma.invite.create({
      data: {
        token: crypto.randomUUID(),
        vaultId: dto.vaultId,
        email: dto.email,
        status: InviteStatus.PENDING,
        invitedBy: userId,
        expiresAt,
      },
    });

    return invite;
  }

  async getByToken(token: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: {
        vault: {
          select: {
            id: true,
            title: true,
            totalAmount: true,
            status: true,
            client: { select: { name: true } },
          },
        },
      },
    });

    if (!invite) {
      throw new NotFoundException("Invite not found");
    }

    if (invite.status !== InviteStatus.PENDING || invite.expiresAt < new Date()) {
      throw new BadRequestException("Invite expired or already responded");
    }

    return {
      invite,
      vault: {
        ...invite.vault,
        clientName: invite.vault.client.name,
        isFunded: invite.vault.status !== VaultStatus.DRAFT && invite.vault.status !== VaultStatus.AWAITING_FUNDING,
      },
    };
  }

  async getByVaultId(vaultId: string, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException("Vault not found");
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException("Not authorized");
    }

    const invite = await this.prisma.invite.findFirst({
      where: {
        vaultId,
        status: InviteStatus.PENDING,
      },
      orderBy: { invitedAt: "desc" },
    });

    return invite;
  }

  async respond(token: string, dto: RespondInviteDto, userId: string, email: string) {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: { vault: true },
    });

    if (!invite) throw new NotFoundException("Invite not found");
    if (invite.email !== email) throw new ForbiddenException("Email mismatch");
    if (invite.status !== InviteStatus.PENDING) throw new BadRequestException("Already responded");

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedInvite = await tx.invite.update({
        where: { id: invite.id },
        data: {
          status: dto.action === "accept" ? InviteStatus.ACCEPTED : InviteStatus.DECLINED,
          declineReason: dto.declineReason,
          respondedAt: new Date(),
        },
      });

      let vault: any = null;
      if (dto.action === "accept") {
        vault = await tx.vault.update({
          where: { id: invite.vaultId },
          data: {
            freelancerId: userId,
            status: invite.vault.status === VaultStatus.FUNDED_UNASSIGNED ? VaultStatus.ACTIVE : VaultStatus.FUNDED_ASSIGNED,
          },
        });
      }

      return { invite: updatedInvite, vault };
    });

    return result;
  }
}
