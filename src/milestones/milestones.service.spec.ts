import { Test, TestingModule } from '@nestjs/testing';
import { MilestonesService } from './milestones.service';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationService } from '../verification/verification.service';
import { EvidenceService } from '../evidence/evidence.service';

describe('MilestonesService', () => {
  let service: MilestonesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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

    service = module.get<MilestonesService>(MilestonesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
