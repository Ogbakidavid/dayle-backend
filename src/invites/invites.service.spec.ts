import { Test, TestingModule } from '@nestjs/testing';
import { InvitesService } from './invites.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { RedisService } from '../common/redis/redis.service';

describe('InvitesService', () => {
  let service: InvitesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
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

    service = module.get<InvitesService>(InvitesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
