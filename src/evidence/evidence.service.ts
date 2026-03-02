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

  async create(userId: string, role: string, dto: CreateEvidenceDto) {
    const prisma = this.prisma;
    const vault = await prisma.vault.findUnique({
      where: { id: dto.vaultId },
    });

    if (!vault) throw new NotFoundException('Vault not found');
    if (vault.clientId !== userId && vault.freelancerId !== userId) {
      throw new ForbiddenException('Not authorized');
    }

    const evidence = await prisma.evidence.create({
      data: {
        vaultId: dto.vaultId,
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
    vaultId: string,
    type?: EvidenceType,
  ) {
    const prisma = this.prisma;

    if (!vaultId) {
      throw new NotFoundException('Vault ID is required');
    }

    const vault = await prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) throw new NotFoundException('Vault not found');

    // Allow Admins or participants
    const isParticipant =
      vault.clientId === userId || vault.freelancerId === userId;
    const isAdmin = role === 'ADMIN';

    if (!isParticipant && !isAdmin) {
      throw new ForbiddenException('Not authorized');
    }

    const where: Prisma.EvidenceWhereInput = {
      vaultId,
      type: (type as unknown as PrismaEvidenceType) || undefined,
    };

    return prisma.evidence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }
}
