import { Test, TestingModule } from '@nestjs/testing';
import { ReconcilerService } from './reconciler.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { VaultStatus, LedgerEntryType, TransactionStatus } from '../domain/enums';

describe('ReconcilerService', () => {
  let service: ReconcilerService;
  let prisma: PrismaService;

  const mockPrisma = {
    vault: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockPartna = {};
  const mockPaycrest = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconcilerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PartnaService, useValue: mockPartna },
        { provide: PaycrestService, useValue: mockPaycrest },
      ],
    }).compile();

    service = module.get<ReconcilerService>(ReconcilerService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  const mockVault = {
    id: 'vault-1',
    totalAmount: 1000,
    status: VaultStatus.FUNDED_ASSIGNED,
    ledgerEntries: [],
  };

  it('should freeze vault if total deposited is less than vault amount', async () => {
    mockPrisma.vault.findMany.mockResolvedValue([
      { ...mockVault, ledgerEntries: [] }, // No deposits found
    ]);

    await service.reconcileVaults();

    expect(mockPrisma.vault.update).toHaveBeenCalledWith({
      where: { id: 'vault-1' },
      data: expect.objectContaining({
        isFrozen: true,
        frozenReason: expect.stringContaining('Funding Mismatch'),
      }),
    });
  });

  it('should freeze vault if ledger balance is negative', async () => {
    mockPrisma.vault.findMany.mockResolvedValue([
      {
        ...mockVault,
        ledgerEntries: [
          { type: LedgerEntryType.DEPOSIT, amount: 1000, status: TransactionStatus.CONFIRMED },
          { type: LedgerEntryType.RELEASE, amount: 1500, status: TransactionStatus.CONFIRMED }, // Over-release
        ],
      },
    ]);

    await service.reconcileVaults();

    expect(mockPrisma.vault.update).toHaveBeenCalledWith({
      where: { id: 'vault-1' },
      data: expect.objectContaining({
        isFrozen: true,
        frozenReason: expect.stringContaining('Negative Balance Detected'),
      }),
    });
  });

  it('should NOT freeze vault if integrity checks pass', async () => {
    mockPrisma.vault.update.mockClear(); // Clear previous calls
    
    // Ledger balance = 1000 - 500 = 500 (Positive)
    // Total deposited = 1000 (Matches vault total)
    mockPrisma.vault.findMany.mockResolvedValue([
      {
        ...mockVault,
        ledgerEntries: [
          { type: LedgerEntryType.DEPOSIT, amount: 1000, status: TransactionStatus.CONFIRMED },
          { type: LedgerEntryType.RELEASE, amount: 500, status: TransactionStatus.CONFIRMED },
        ],
      },
    ]);

    await service.reconcileVaults();

    expect(mockPrisma.vault.update).not.toHaveBeenCalled();
  });
});
