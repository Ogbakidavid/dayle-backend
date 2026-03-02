import { Test, TestingModule } from '@nestjs/testing';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../prisma/prisma.service';
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
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  const mockDispute = {
    id: 'dispute-1',
    status: DisputeStatus.OPEN,
    vaultId: 'vault-1',
    vault: {
      id: 'vault-1',
      freelancerId: 'freelancer-1',
      clientId: 'client-1',
      totalAmount: 1000,
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
        amount: 1000,
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
        amount: 1000,
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

    // Release 400 to freelancer
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: LedgerEntryType.RELEASE,
        userId: 'freelancer-1',
        amount: 400,
      }),
    });
    // Refund 600 to client
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: LedgerEntryType.REFUND,
        userId: 'client-1',
        amount: 600,
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
