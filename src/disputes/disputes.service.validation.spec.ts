import { Test, TestingModule } from '@nestjs/testing';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BadRequestException } from '@nestjs/common';
import { DisputeStatus, UserRole } from '../domain/enums';

describe('DisputesService Timer and Escalation', () => {
  let service: DisputesService;
  let prisma: PrismaService;

  const mockVault = {
    id: 'vault-1',
    clientId: 'client-1',
    freelancerId: 'freelancer-1',
    totalAmount: 100000000n,
    tokenDecimals: 6,
  };

  const mockDispute = {
    id: 'dispute-1',
    status: DisputeStatus.MUTUAL_RESOLUTION,
    vault: mockVault,
    vaultId: 'vault-1',
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: {
            dispute: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
            disputeEvent: {
              create: jest.fn(),
            },
            notification: {
              create: jest.fn(),
            },
            $transaction: jest.fn((callback) => callback({
              dispute: {
                update: jest.fn(),
                findUnique: jest.fn().mockResolvedValue(mockDispute),
              },
              disputeEvent: {
                create: jest.fn(),
              },
            })),
          },
        },
        {
          provide: BlockchainService,
          useValue: {},
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should reset timer to 48 hours on new proposal', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(mockDispute);
    const txUpdateSpy = jest.fn();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb({
      dispute: {
        update: txUpdateSpy,
        findUnique: jest.fn().mockResolvedValue(mockDispute),
      },
      disputeEvent: { create: jest.fn() },
    }));

    await service.proposeSettlement('dispute-1', 'client-1', {
      amountToFreelancer: 50,
      notes: 'Test reset',
    });

    expect(txUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dispute-1' },
      data: expect.objectContaining({
        resolutionWindowExpiresAt: expect.any(Date),
      }),
    }));
    
    const callDate = txUpdateSpy.mock.calls[0][0].data.resolutionWindowExpiresAt;
    const diffHours = (callDate.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(diffHours).toBeGreaterThan(47.9);
    expect(diffHours).toBeLessThan(48.1);
  });

  it('should cap timer at 96 hours from creation', async () => {
    // Dispute created 80 hours ago. 80 + 48 = 128 (exceeds 96).
    // So expiry should be createdAt + 96h (which is now + 16h).
    const eightyHoursAgo = new Date(Date.now() - 80 * 60 * 60 * 1000);
    const disputeWithAge = { ...mockDispute, createdAt: eightyHoursAgo };
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(disputeWithAge);
    
    const txUpdateSpy = jest.fn();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb({
      dispute: {
        update: txUpdateSpy,
        findUnique: jest.fn().mockResolvedValue(disputeWithAge),
      },
      disputeEvent: { create: jest.fn() },
    }));

    await service.proposeSettlement('dispute-1', 'client-1', {
      amountToFreelancer: 50,
      notes: 'Test cap',
    });

    const callDate = txUpdateSpy.mock.calls[0][0].data.resolutionWindowExpiresAt;
    const diffFromCreation = (callDate.getTime() - eightyHoursAgo.getTime()) / (1000 * 60 * 60);
    expect(diffFromCreation).toBeCloseTo(96, 0);
  });

  it('should force escalate if attempted after 96 hours', async () => {
    // Dispute created 100 hours ago
    const hundredHoursAgo = new Date(Date.now() - 100 * 60 * 60 * 1000);
    const oldDispute = { ...mockDispute, createdAt: hundredHoursAgo };
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(oldDispute);
    
    const txUpdateSpy = jest.fn();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb({
      dispute: {
        update: txUpdateSpy,
        findUnique: jest.fn().mockResolvedValue(oldDispute),
      },
      disputeEvent: { create: jest.fn() },
    }));

    await expect(
      service.proposeSettlement('dispute-1', 'client-1', {
        amountToFreelancer: 50,
        notes: 'Too late',
      }),
    ).rejects.toThrow(new BadRequestException("The mutual resolution window has closed. Your dispute is now under platform review."));

    expect(txUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: DisputeStatus.UNDER_REVIEW },
    }));
  });

  it('should allow total refund request and reset timer', async () => {
    (prisma.dispute.findUnique as jest.Mock).mockResolvedValue(mockDispute);
    const txUpdateSpy = jest.fn();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb({
      dispute: {
        update: txUpdateSpy,
        findUnique: jest.fn().mockResolvedValue(mockDispute),
      },
      disputeEvent: { create: jest.fn() },
    }));

    await service.requestTotalRefund('dispute-1', 'client-1', 'Full refund please');

    expect(txUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      data: { resolutionWindowExpiresAt: expect.any(Date) },
    }));
  });
});
