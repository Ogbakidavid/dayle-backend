import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { DiditService } from '../common/services/didit.service';
import { CryptoService } from '../common/services/crypto.service';
import { PartnaService } from '../common/services/partna.service';
describe('OnboardingController', () => {
  let controller: OnboardingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OnboardingController],
      providers: [
        OnboardingService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: DiditService,
          useValue: {},
        },
        {
          provide: CryptoService,
          useValue: {},
        },
        {
          provide: PartnaService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<OnboardingController>(OnboardingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
