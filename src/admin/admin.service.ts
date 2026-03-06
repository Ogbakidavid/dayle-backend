import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  UserRole,
  VaultStatus,
  DisputeStatus,
} from '../domain/enums';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async getStats(user: any) {
    const prisma = this.prisma;
    const totalUsers = await prisma.user.count();
    const activeVaults = await prisma.vault.count({
      where: { status: VaultStatus.FUNDED },
    });
    const pendingDisputes = await prisma.dispute.count({
      where: { status: DisputeStatus.OPEN },
    });
    const totalVolume = await prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { type: 'RELEASE', status: 'CONFIRMED' },
    });

    // Calculate Volume Trends (Last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1); // Start of month

    const recentVolumes = await prisma.ledgerEntry.findMany({
      where: {
        type: 'RELEASE',
        status: 'CONFIRMED',
        createdAt: { gte: sixMonthsAgo },
      },
      select: {
        amount: true,
        createdAt: true,
      },
    });

    const volumeMap = new Map<string, bigint>();
    // Initialize map with last 6 months
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthName = d.toLocaleString('default', { month: 'short' });
      volumeMap.set(monthName, BigInt(0));
    }

    recentVolumes.forEach((entry) => {
      const month = entry.createdAt.toLocaleString('default', {
        month: 'short',
      });
      if (volumeMap.has(month)) {
        volumeMap.set(month, volumeMap.get(month)! + entry.amount);
      }
    });

    const volumeTrends = Array.from(volumeMap.entries())
      .map(([month, volume]) => ({ month, volume }))
      .reverse();

    return {
      totalUsers,
      activeVaults,
      totalVolume: totalVolume._sum?.amount || BigInt(0),
      pendingDisputes,
      volumeTrends,
    };
  }

  async getSystemLogs(user: any, limit = 10) {
    const prisma = this.prisma;
    const users = await prisma.user.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, createdAt: true },
    });
    const vaults = await prisma.vault.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        totalAmount: true,
        createdAt: true,
      },
    });
    const disputes = await prisma.dispute.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, reasonCode: true, createdAt: true },
    });
    const kyc = await prisma.user.findMany({
      where: { kycStatus: 'VERIFIED' },
      take: limit,
      orderBy: { updatedAt: 'desc' }, // Approximate
      select: { id: true, email: true, updatedAt: true },
    });
    const ledger = await prisma.ledgerEntry.findMany({
      take: limit,
      where: { status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, amount: true, createdAt: true },
    });

    const logs: any[] = [];

    users.forEach((u) =>
      logs.push({
        id: `user-${u.id}`,
        event: 'NODE_AUTH_SUCCESS',
        desc: `New user registration: ${u.email}`,
        time: u.createdAt,
        type: 'SUCCESS',
      }),
    );

    vaults.forEach((v) =>
      logs.push({
        id: `vault-${v.id}`,
        event: v.status === 'FUNDED' ? 'VAULT_LOCK_CONFIRMED' : 'VAULT_CREATED',
        desc: `Vault "${v.title}" ($${v.totalAmount}) - ${v.status}`,
        time: v.createdAt,
        type: v.status === 'FUNDED' ? 'SUCCESS' : 'INFO',
      }),
    );

    disputes.forEach((d) =>
      logs.push({
        id: `dispute-${d.id}`,
        event: 'PROTOCOL_DISPUTE',
        desc: `Dispute opened: ${d.reasonCode}`,
        time: d.createdAt,
        type: 'ERROR',
      }),
    );

    kyc.forEach((k) =>
      logs.push({
        id: `kyc-${k.id}`,
        event: 'KYC_CLEARANCE_ISSUED',
        desc: `Identity verified for ${k.email}`,
        time: k.updatedAt, // Using updated at as proxy for verification time
        type: 'SUCCESS',
      }),
    );

    ledger
      .filter((l) => l.type === 'LOCK')
      .forEach((l) =>
        logs.push({
          id: `ledger-${l.id}`,
          event: 'VAULT_LOCK_CONFIRMED',
          desc: `Escrow funded via smart contract ($${l.amount})`,
          time: l.createdAt,
          type: 'SUCCESS',
        }),
      );

    return logs
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, limit);
  }

  async getUsers(user: any) {
    const prisma = this.prisma;
    return prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        kycStatus: true,
        kycData: true,
        createdAt: true,
      },
    });
  }

  async getVaults(user: any) {
    const prisma = this.prisma;
    return prisma.vault.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { name: true } },
        freelancer: { select: { name: true } },
      },
    });
  }

  async getDisputes(user: any) {
    const prisma = this.prisma;
    return prisma.dispute.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        vault: { select: { title: true } },
      },
    });
  }

  async handleKyc(
    admin: any,
    userId: string,
    status: 'VERIFIED' | 'REJECTED',
    reason?: string,
  ) {
    const prisma = this.prisma;
    return prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: status,
        kycData: {
          update: {
            rejectionReason: reason,
            reviewedAt: new Date(),
          },
        },
      },
    });
  }

  async getLedger(user: any) {
    const prisma = this.prisma;
    return prisma.ledgerEntry.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true } },
        vault: { select: { title: true } },
      },
    });
  }

  async resolveDispute(
    adminId: string,
    role: string,
    id: string,
    dto: ResolveDisputeDto,
  ) {
    const prisma = this.prisma;
    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!dispute) {
      throw new Error('Dispute not found');
    }

    return prisma.$transaction(async (tx) => {
      // 1. Update Dispute
      const updatedDispute = await tx.dispute.update({
        where: { id },
        data: {
          status: dto.status,
          resolution: dto.resolution,
          resolvedAt: new Date(),
        },
      });

      // 2. Update Vault Status if provided
      if (dto.nextVaultStatus) {
        await tx.vault.update({
          where: { id: dispute.vaultId },
          data: { status: dto.nextVaultStatus as any },
        });
      }

      // 3. Log event
      await tx.disputeEvent.create({
        data: {
          disputeId: id,
          eventType:
            dto.status === DisputeStatus.RESOLVED ? 'RESOLVED' : 'REJECTED',
          payload: {
            resolution: dto.resolution,
            nextVaultStatus: dto.nextVaultStatus,
          },
        },
      });

      return updatedDispute;
    });
  }
}
