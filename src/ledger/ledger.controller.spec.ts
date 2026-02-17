import { Test, TestingModule } from '@nestjs/testing';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';

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
      ],
    }).compile();

    controller = module.get<LedgerController>(LedgerController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
