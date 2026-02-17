import { Test, TestingModule } from '@nestjs/testing';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from '../verification/verification.service';
import { EvidenceService } from '../evidence/evidence.service';

describe('MilestonesController', () => {
  let controller: MilestonesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MilestonesController],
      providers: [
        MilestonesService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: VerificationService,
          useValue: { verify: jest.fn() },
        },
        {
          provide: EvidenceService,
          useValue: { list: jest.fn(), create: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<MilestonesController>(MilestonesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
