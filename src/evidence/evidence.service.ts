import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEvidenceDto } from './dto/create-evidence.dto';
import { EvidenceType } from '../domain/enums';
import { Prisma, EvidenceType as PrismaEvidenceType } from '@prisma/client';

@Injectable()
export class EvidenceService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateEvidenceDto) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: dto.vaultId },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException('Not authorized');
    }

    const evidence = await this.prisma.evidence.create({
      data: {
        vaultId: dto.vaultId,
        milestoneId: dto.milestoneId,
        disputeId: dto.disputeId,
        type: dto.type as unknown as PrismaEvidenceType,
        payload: dto.payload as Prisma.InputJsonValue,
        createdBy: userId,
      },
    });

    return evidence;
  }

  async list(
    userId: string,
    role: string,
    vaultId?: string,
    milestoneId?: string,
    type?: EvidenceType,
  ) {
    let effectiveVaultId = vaultId;

    // If vaultId is missing but milestoneId is provided, derive vaultId
    if (!effectiveVaultId && milestoneId) {
      const milestone = await this.prisma.milestone.findUnique({
        where: { id: milestoneId },
        select: { vaultId: true },
      });
      if (milestone) {
        effectiveVaultId = milestone.vaultId;
      }
    }

    if (!effectiveVaultId) {
      throw new NotFoundException('Vault ID is required or could not be derived');
    }

    const vault = await this.prisma.vault.findUnique({
      where: { id: effectiveVaultId },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    
    // Allow Admins or participants
    const isParticipant = vault.clientId === userId || vault.freelancerId === userId;
    const isAdmin = role === 'ADMIN';

    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('Not authorized');
    }

    const where: Prisma.EvidenceWhereInput = {
      vaultId: effectiveVaultId,
      milestoneId: milestoneId || undefined,
      type: (type as unknown as PrismaEvidenceType) || undefined,
    };

    return this.prisma.evidence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }
}
