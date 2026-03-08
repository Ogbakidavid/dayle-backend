import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { RespondInviteDto } from './dto/respond-invite.dto';
import { InviteStatus, VaultStatus, UserRole } from '../domain/enums';
import * as crypto from 'crypto';
import { BlockchainService } from '../common/services/blockchain.service';
import { ethers } from 'ethers';

import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  constructor(
    private prisma: PrismaService,
    private blockchainService: BlockchainService,
    private redis: RedisService,
  ) {}

  async create(dto: CreateInviteDto, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: dto.vaultId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException('Only vault client can invite');
    }

    if (vault.freelancerId) {
      throw new BadRequestException('Vault already has a freelancer');
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
            amount: true,
            totalAmount: true,
            status: true,
            client: { select: { name: true } },
            vaultAddress: true,
          },
        },
      },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    if (
      invite.status !== InviteStatus.PENDING ||
      invite.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invite expired or already responded');
    }

    return {
      invite,
      vault: {
        ...invite.vault,
        clientName: invite.vault.client.name,
        formattedTotalAmount: ethers.formatUnits(
          invite.vault.totalAmount || invite.vault.amount,
          6,
        ),
        isFunded:
          invite.vault.status !== VaultStatus.DRAFT &&
          invite.vault.status !== VaultStatus.CANCELLED,
      },
    };
  }

  async getByVaultId(vaultId: string, userId: string) {
    const vault = await this.prisma.vault.findUnique({
      where: { id: vaultId },
    });

    if (!vault) {
      throw new NotFoundException('Vault not found');
    }

    if (vault.clientId !== userId) {
      throw new ForbiddenException('Not authorized');
    }

    const invite = await this.prisma.invite.findFirst({
      where: {
        vaultId,
        status: InviteStatus.PENDING,
      },
      orderBy: { invitedAt: 'desc' },
    });

    return invite;
  }

  async listPendingByEmail(email: string) {
    this.logger.log(`Fetching pending invitations for email: ${email}`);
    const invitations = await this.prisma.invite.findMany({
      where: {
        email: { equals: email, mode: 'insensitive' },
        status: InviteStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      include: {
        vault: {
          select: {
            id: true,
            title: true,
            amount: true,
            totalAmount: true,
            status: true,
            client: { select: { name: true } },
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });
    this.logger.log(`Found ${invitations.length} pending invitations for ${email}`);
    return invitations.map((invite) => ({
      ...invite,
      vault: {
        ...invite.vault,
        formattedTotalAmount: ethers.formatUnits(
          invite.vault.totalAmount || invite.vault.amount,
          6,
        ),
        isFunded:
          invite.vault.status !== VaultStatus.DRAFT &&
          invite.vault.status !== VaultStatus.CANCELLED,
      },
    }));
  }

  async respond(
    token: string,
    dto: RespondInviteDto,
    userId: string,
    email: string,
  ) {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: { vault: true },
    });

    if (!invite) throw new NotFoundException('Invite not found');
    if (invite.email !== email) throw new ForbiddenException('Email mismatch');
    if (invite.status !== InviteStatus.PENDING)
      throw new BadRequestException('Already responded');

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedInvite = await tx.invite.update({
        where: { id: invite.id },
        data: {
          status:
            dto.action === 'accept'
              ? InviteStatus.ACCEPTED
              : InviteStatus.DECLINED,
          declineReason: dto.declineReason,
          respondedAt: new Date(),
        },
      });

      let vault: any = null;
      if (dto.action === 'accept') {
        // 0. Upgrade user role to FREELANCER if it's currently NONE
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (user && user.role === UserRole.NONE) {
          await tx.user.update({
            where: { id: userId },
            data: { role: UserRole.FREELANCER },
          });
          this.logger.log(`Upgraded user ${userId} to FREELANCER upon invitation acceptance`);
        }

        // 1. Link the freelancer to the vault in DB
        vault = await tx.vault.update({
          where: { id: invite.vaultId },
          data: { freelancerId: userId },
          include: {
            client: { select: { wallet: true } },
            freelancer: { select: { wallet: true } },
          },
        });

        // 2. Handle On-Chain Handover or Deployment
        if (vault.vaultAddress) {
          // Vault already exists (Proactive model). Hand over to the real freelancer.
          const freelancerWallet = vault.freelancer?.wallet?.address;
          const isValidEthAddress = (addr: string) => 
            addr && addr.startsWith('0x') && addr.length === 42;

          if (isValidEthAddress(freelancerWallet)) {
            try {
              this.logger.log(
                `Handing over Vault ${vault.vaultAddress} to freelancer ${freelancerWallet}...`,
              );
              await this.blockchainService.updateVaultFreelancer(
                vault.vaultAddress,
                freelancerWallet,
              );
            } catch (err) {
              this.logger.error(
                `Failed to update freelancer on-chain for vault ${vault.id}`,
                err,
              );
            }
          }
        } else {
          // Vault wasn't deployed. Try deploying now.
          const clientWallet = vault.client?.wallet?.address;
          const freelancerWallet = vault.freelancer?.wallet?.address;

          const isValidEthAddress = (addr: string) => 
            addr && addr.startsWith('0x') && addr.length === 42;

          if (isValidEthAddress(clientWallet) && isValidEthAddress(freelancerWallet)) {
            try {
              const wasFundedLocally = vault.status === VaultStatus.FUNDED;
              this.logger.log(
                `Acceptance triggered fresh deployment for Vault ${vault.id}...`,
              );
              const { vaultAddress } = await this.blockchainService.deployVault(
                clientWallet,
                freelancerWallet,
                vault.totalAmount.toString(),
                vault.tokenAddress,
              );

              // Update the vault with the on-chain address and status
              vault = await tx.vault.update({
                where: { id: vault.id },
                data: {
                  vaultAddress,
                  status: VaultStatus.FUNDED, // Mark as funded (deployment successful)
                },
              });

              // 3. If the vault was already funded via fiat (DRAFT phase),
              // we now move those funds from treasury to the new on-chain vault
              if (wasFundedLocally) {
                this.logger.log(
                  `Vault ${vault.id} was pre-funded. Triggering on-chain deposit...`,
                );
                await this.blockchainService.depositToVault(
                  vaultAddress,
                  vault.totalAmount,
                  vault.tokenAddress,
                );
              }

              this.logger.log(
                `Vault ${vault.id} deployed successfully at ${vaultAddress}`,
              );
            } catch (err) {
              this.logger.error(
                `Failed to deploy/fund vault ${vault.id} on acceptance`,
                err,
              );
              // In this case, we've accepted the invite but deployment/funding failed.
              // We log the error but allow the acceptance to stand.
            }
          } else {
            this.logger.error(
              `Missing wallet(s) for deployment: Client=${clientWallet}, Freelancer=${freelancerWallet}`,
            );
          }
        }
      }

      // 4. Invalidate the freelancer's dashboard cache
      try {
        const cacheKey = `vaults:list:FREELANCER:${userId}`;
        await this.redis.del(cacheKey);
        this.logger.log(`Invalidated cache for freelancer ${userId}: ${cacheKey}`);
      } catch (err) {
        this.logger.error(`Failed to invalidate freelancer cache for ${userId}`, err);
      }

      return { 
        success: true, 
        invite: updatedInvite, 
        vault: vault,
        vaultId: vault?.id 
      };
    });

    return result;
  }
}
