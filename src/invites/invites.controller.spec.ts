import { Test, TestingModule } from '@nestjs/testing';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { RedisService } from '../common/redis/redis.service';

describe('InvitesController', () => {
  let controller: InvitesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitesController],
      providers: [
        InvitesService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: BlockchainService,
          useValue: {},
        },
        {
          provide: RedisService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<InvitesController>(InvitesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
