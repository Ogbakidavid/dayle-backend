import { Test, TestingModule } from '@nestjs/testing';
import { VaultsService } from './vaults.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { PaymentRouter } from '../common/services/payment-router.service';

describe('VaultsService', () => {
  let service: VaultsService;

  const mockPrismaService = {};
  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };
  const mockPaymentRouter = {
    initiateOnramp: jest.fn(),
    initiateOfframp: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VaultsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
        {
          provide: PaymentRouter,
          useValue: mockPaymentRouter,
        },
      ],
    }).compile();

    service = module.get<VaultsService>(VaultsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
