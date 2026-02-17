import { Test, TestingModule } from '@nestjs/testing';
import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

describe('VaultsController', () => {
  let controller: VaultsController;

  const mockVaultsService = {};
  const mockPrismaService = {};
  const mockRedisService = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VaultsController],
      providers: [
        {
          provide: VaultsService,
          useValue: mockVaultsService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    controller = module.get<VaultsController>(VaultsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
