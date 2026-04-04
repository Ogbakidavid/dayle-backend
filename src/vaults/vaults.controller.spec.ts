import { Test, TestingModule } from '@nestjs/testing';
import { VaultsController } from './vaults.controller';
import { VaultsService } from './vaults.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { ConfigService } from '@nestjs/config';

describe('VaultsController', () => {
  let controller: VaultsController;

  const mockVaultsService = {};
  const mockPrismaService = {};
  const mockRedisService = {};
  const mockConfigService = { get: jest.fn() };

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
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    controller = module.get<VaultsController>(VaultsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
