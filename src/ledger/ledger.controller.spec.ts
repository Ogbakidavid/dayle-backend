import { Test, TestingModule } from '@nestjs/testing';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentRouter } from '../common/services/payment-router.service';
import { ConfigService } from '@nestjs/config';

describe('LedgerController', () => {
  let controller: LedgerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LedgerController],
      providers: [
        LedgerService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: PaymentRouter,
          useValue: { initiateOfframp: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<LedgerController>(LedgerController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
