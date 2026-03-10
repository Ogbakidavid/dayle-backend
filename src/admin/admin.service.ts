import { Injectable } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { ethers } from 'ethers';
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
      totalVolume: ethers.formatUnits(totalVolume._sum?.amount || BigInt(0), 6),
      pendingDisputes,
      volumeTrends: volumeTrends.map(t => ({
        month: t.month,
        volume: ethers.formatUnits(t.volume, 6)
      })),
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
        event: v.status === VaultStatus.FUNDED ? 'VAULT_LOCK_CONFIRMED' : 'VAULT_CREATED',
        desc: `Vault "${v.title}" (${ethers.formatUnits(v.totalAmount, 6)}) - ${v.status}`,
        time: v.createdAt,
        type: v.status === VaultStatus.FUNDED ? 'SUCCESS' : 'INFO',
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
          desc: `Escrow funded via smart contract (${ethers.formatUnits(l.amount, 6)})`,
          time: l.createdAt,
          type: 'SUCCESS',
        }),
      );

    return logs
      .filter(log => log.time instanceof Date || !isNaN(Date.parse(log.time)))
      .sort((a, b) => {
        const timeA = a.time instanceof Date ? a.time.getTime() : new Date(a.time).getTime();
        const timeB = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
        return timeB - timeA;
      })
      .slice(0, limit);
  }
  
  async getDiditWebhookLogs(user: any) {
    try {
      const filePath = path.join(process.cwd(), 'webhook-logs.json');
      const data = await fs.readFile(filePath, 'utf8');
      const lines = data.split('\n').filter((line) => line.trim() !== '');
      return lines.map((line) => JSON.parse(line)).reverse();
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
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
    const vaults = await prisma.vault.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        client: { select: { name: true } },
        freelancer: { select: { name: true } },
      },
    });

    return vaults.map((v) => ({
      ...v,
      totalAmount: ethers.formatUnits(v.totalAmount, v.tokenDecimals),
    }));
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
    const entries = await prisma.ledgerEntry.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true } },
        vault: { select: { title: true, tokenDecimals: true } },
      },
    });

    return entries.map((e) => ({
      ...e,
      amount: ethers.formatUnits(e.amount, e.vault?.tokenDecimals || 6),
    }));
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
