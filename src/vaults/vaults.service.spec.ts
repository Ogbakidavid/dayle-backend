import { Test, TestingModule } from '@nestjs/testing';
import { VaultsService } from './vaults.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { PaymentRouter } from '../common/services/payment-router.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { InvitesService } from '../invites/invites.service';
import { MailsService } from '../notifications/mails.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { RatesService } from '../rates/rates.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { getQueueToken } from '@nestjs/bullmq';

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
  const mockBlockchainService = {
    deployVault: jest.fn(),
    depositToVault: jest.fn(),
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
        {
          provide: BlockchainService,
          useValue: mockBlockchainService,
        },
        {
          provide: InvitesService,
          useValue: {},
        },
        {
          provide: MailsService,
          useValue: {},
        },
        {
          provide: PaycrestService,
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { createNotification: jest.fn() },
        },
        {
          provide: RatesService,
          useValue: { getDisplayRate: jest.fn(), getTransactionRate: jest.fn() },
        },
        {
          provide: PartnaService,
          useValue: {
            createRamp: jest.fn(),
            getRate: jest.fn(),
            mockDepositFiat: jest.fn(),
          },
        },
        {
          provide: getQueueToken('withdrawal-retry'),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<VaultsService>(VaultsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
