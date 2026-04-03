import { Test, TestingModule } from '@nestjs/testing';
import { RatesService } from './rates.service';
import { PrismaService } from '../prisma/prisma.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { BadRequestException } from '@nestjs/common';
import { RateType } from '@prisma/client';

describe('RatesService', () => {
  let service: RatesService;
  let prisma: PrismaService;
  let partna: PartnaService;
  let paycrest: PaycrestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatesService,
        {
          provide: PrismaService,
          useValue: {
            exchangeRateLog: {
              create: jest.fn(),
            },
          },
        },
        {
          provide: PartnaService,
          useValue: {
            getRate: jest.fn(),
          },
        },
        {
          provide: PaycrestService,
          useValue: {
            getExchangeRate: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<RatesService>(RatesService);
    prisma = module.get<PrismaService>(PrismaService);
    partna = module.get<PartnaService>(PartnaService);
    paycrest = module.get<PaycrestService>(PaycrestService);
  });

  describe('getDisplayRate', () => {
    it('should fetch NGN rate and cache it for 60s', async () => {
      (partna.getRate as jest.Mock).mockResolvedValue({
        data: {
          rate: {
            NGN_to_USDC: { rate: 1500, key: 'rk-123' },
          },
        },
      });

      const res1 = await service.getDisplayRate('NGN', 100);
      expect(res1.rate).toBe(1500);

      // Second call should be cached
      const res2 = await service.getDisplayRate('NGN', 100);
      expect(res2.rate).toBe(1500);
      expect(partna.getRate).toHaveBeenCalledTimes(1);
    });

    it('should fallback to stale cache (up to 5m) if API fails', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-03-20T10:00:00Z'));

      (partna.getRate as jest.Mock).mockResolvedValue({
        data: {
          rate: {
            NGN_to_USDC: { rate: 1500, key: 'rk-123' },
          },
        },
      });
      await service.getDisplayRate('NGN', 100); // Prime cache

      // Advance time by 70s (past 60s TTL but within 5m fallback)
      jest.advanceTimersByTime(70000);

      (partna.getRate as jest.Mock).mockRejectedValue(new Error('API Down'));

      const res = await service.getDisplayRate('NGN', 100);
      expect(res.rate).toBe(1500);
      expect(res.isStale).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('getTransactionRate', () => {
    it('should fetch fresh rate for withdrawal every time', async () => {
      (partna.getRate as jest.Mock).mockResolvedValue({
        data: {
          rate: {
            USDC_to_KES: { rate: 135, key: 'rk-456' },
          },
        },
      });

      await service.getTransactionRate('KES', 100, 'v1', 'withdrawal');
      await service.getTransactionRate('KES', 100, 'v1', 'withdrawal');

      expect(partna.getRate).toHaveBeenCalledTimes(2);
      expect(prisma.exchangeRateLog.create).toHaveBeenCalledTimes(2);
    });

    it('should cache funding rate for 10 mins', async () => {
      (partna.getRate as jest.Mock).mockResolvedValue({
        data: {
          rate: {
            NGN_to_USDC: { rate: 1600, key: 'rk-789' },
          },
        },
      });

      await service.getTransactionRate('NGN', 100, 'v1', 'funding');
      await service.getTransactionRate('NGN', 100, 'v1', 'funding');

      expect(partna.getRate).toHaveBeenCalledTimes(1);
      expect(prisma.exchangeRateLog.create).toHaveBeenCalledTimes(1);
    });

    it('should log detailed audit info for transactions', async () => {
      (partna.getRate as jest.Mock).mockResolvedValue({
        data: {
          rate: {
            NGN_to_USDC: { rate: 1600, key: 'rk-789' },
          },
        },
      });

      const res = await service.getTransactionRate(
        'NGN',
        50,
        'vault-abc',
        'funding',
      );
      expect(res.rateKey).toBe('rk-789');

      expect(prisma.exchangeRateLog.create).toHaveBeenCalledWith({
        data: {
          currency: 'NGN',
          amount: 50,
          localAmount: 50 * 1600,
          rate: 1600,
          source: 'Partna v4',
          type: 'TRANSACTION',
          vaultId: 'vault-abc',
        },
      });
    });

    it('should throw BadRequestException if v4 credentials are missing', async () => {
      const approvalMsg =
        'Partna v4 credentials not yet configured — awaiting account approval.';
      (partna.getRate as jest.Mock).mockRejectedValue(new Error(approvalMsg));

      await expect(
        service.getTransactionRate('NGN', 100, 'v1', 'funding'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
