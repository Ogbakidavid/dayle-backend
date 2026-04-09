import { Test, TestingModule } from '@nestjs/testing';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailsService } from '../notifications/mails.service';
import { RedisService } from '../common/redis/redis.service';
import {
  ResolveDisputeDto,
  DisputeResolutionOutcome,
} from './dto/resolve-dispute.dto';
import {
  UserRole,
  DisputeStatus,
  LedgerEntryType,
  TransactionStatus,
  VaultStatus,
} from '../domain/enums';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

describe('DisputesService Adjudication', () => {
  let service: DisputesService;
  let prisma: PrismaService;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
    dispute: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: {
      create: jest.fn(),
    },
    disputeEvent: {
      create: jest.fn(),
    },
    vault: {
      update: jest.fn(),
    },
    admin: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: BlockchainService,
          useValue: {
            releaseVault: jest.fn(),
            refundVault: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
        {
          provide: MailsService,
          useValue: {
            sendVaultStatusEmail: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            publish: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
    prisma = module.get<PrismaService>(PrismaService);

    // Reset mocks
    jest.clearAllMocks();
  });

  const mockDispute = {
    id: 'dispute-1',
    status: DisputeStatus.OPEN,
    vaultId: 'vault-1',
    vault: {
      id: 'vault-1',
      freelancerId: 'freelancer-1',
      clientId: 'client-1',
      tokenDecimals: 18,
      totalAmount: 1000000000000000000000n,
    },
  };

  const mockAdmin = { id: 'admin-1', role: UserRole.ADMIN };

  it('should resolve dispute with RELEASE outcome', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(mockDispute);
    mockPrisma.user.findUnique.mockResolvedValue(mockAdmin);
    mockPrisma.dispute.update.mockResolvedValue({
      ...mockDispute,
      status: DisputeStatus.RESOLVED,
    });

    const dto: ResolveDisputeDto = {
      outcome: DisputeResolutionOutcome.RELEASE,
      notes: 'Work was completed as described',
    };

    await service.resolve('dispute-1', 'admin-1', UserRole.ADMIN, dto);

    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: LedgerEntryType.RELEASE,
        userId: 'freelancer-1',
        amount: 1000000000000000000000n,
      }),
    });
    expect(mockPrisma.dispute.update).toHaveBeenCalledWith({
      where: { id: 'dispute-1' },
      data: expect.objectContaining({ status: DisputeStatus.RESOLVED }),
    });
  });

  it('should resolve dispute with REFUND outcome', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(mockDispute);
    mockPrisma.user.findUnique.mockResolvedValue(mockAdmin);

    const dto: ResolveDisputeDto = {
      outcome: DisputeResolutionOutcome.REFUND,
      notes: 'Freelancer failed to deliver',
    };

    await service.resolve('dispute-1', 'admin-1', UserRole.ADMIN, dto);

    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: LedgerEntryType.REFUND,
        userId: 'client-1',
        amount: 1000000000000000000000n,
      }),
    });
  });

  it('should resolve dispute with SPLIT outcome', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(mockDispute);
    mockPrisma.user.findUnique.mockResolvedValue(mockAdmin);

    const dto: ResolveDisputeDto = {
      outcome: DisputeResolutionOutcome.SPLIT,
      notes: 'Partial work completed',
      splitAmount: 400,
    };

    await service.resolve('dispute-1', 'admin-1', UserRole.ADMIN, dto);

    // 1. Release 400 to freelancer
    expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        type: LedgerEntryType.RELEASE,
        userId: 'freelancer-1',
        amount: 400000000000000000000n,
        description:
          'Dispute Resolution SPLIT (Release): Partial work completed',
        disputeId: 'dispute-1',
        status: TransactionStatus.CONFIRMED,
        vaultId: 'vault-1',
      }),
    });

    // 2. Refund rest to client (1000 - 400 - 40 fee = 560)
    expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        type: LedgerEntryType.REFUND,
        userId: 'client-1',
        amount: 560000000000000000000n,
        description:
          'Dispute Resolution SPLIT (Refund): Partial work completed',
        disputeId: 'dispute-1',
        status: TransactionStatus.CONFIRMED,
        vaultId: 'vault-1',
      }),
    });

    // 3. Fee to treasury (4% of 1000 = 40)
    expect(mockPrisma.ledgerEntry.create).toHaveBeenNthCalledWith(3, {
      data: expect.objectContaining({
        type: LedgerEntryType.FEE,
        userId: 'admin-1',
        amount: 40000000000000000000n,
        description: 'Dispute Resolution SPLIT (Fee): Partial work completed',
        disputeId: 'dispute-1',
        status: TransactionStatus.CONFIRMED,
        vaultId: 'vault-1',
      }),
    });
  });

  it('should throw error if non-admin tries to resolve', async () => {
    mockPrisma.dispute.findUnique.mockResolvedValue(mockDispute);
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.FREELANCER,
    });

    const dto: ResolveDisputeDto = {
      outcome: DisputeResolutionOutcome.RELEASE,
      notes: 'Try to resolve',
    };

    await expect(
      service.resolve('dispute-1', 'user-1', UserRole.FREELANCER, dto),
    ).rejects.toThrow(ForbiddenException);
  });
});
