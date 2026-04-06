import { Test, TestingModule } from '@nestjs/testing';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { DisputeAiService } from './dispute-ai.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailsService } from '../notifications/mails.service';
import { RedisService } from '../common/redis/redis.service';

describe('DisputesController', () => {
  let controller: DisputesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisputesController],
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: BlockchainService,
          useValue: {},
        },
        {
          provide: DisputeAiService,
          useValue: {
            analyzeDispute: jest.fn(),
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            createNotification: jest.fn(),
          },
        },
        {
          provide: MailsService,
          useValue: {
            sendVaultStatusEmail: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            publish: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<DisputesController>(DisputesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
