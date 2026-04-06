import { Test, TestingModule } from '@nestjs/testing';
import { DisputesService } from './disputes.service';
import { PrismaService } from '../prisma/prisma.service';
import { BlockchainService } from '../common/services/blockchain.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailsService } from '../notifications/mails.service';
import { RedisService } from '../common/redis/redis.service';
import { BadRequestException } from '@nestjs/common';
import { VaultStatus, UserRole, KycStatus } from '../domain/enums';

describe('DisputesService', () => {
  let service: DisputesService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        {
          provide: PrismaService,
          useValue: {
            vault: {
              findUnique: jest.fn(),
            },
            user: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: BlockchainService,
          useValue: {},
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

    service = module.get<DisputesService>(DisputesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if vault is released', async () => {
    const vaultId = 'vault-1';
    const userId = 'client-1';
    const role = UserRole.CLIENT;

    (prisma.vault.findUnique as jest.Mock).mockResolvedValue({
      id: vaultId,
      clientId: userId,
      status: VaultStatus.RELEASED,
    });

    (prisma.user.findUnique as jest.Mock).mockResolvedValue({
      id: userId,
      kycStatus: KycStatus.VERIFIED,
    });

    await expect(
      service.create(userId, role, {
        vaultId,
        disputeType: 'FRAUD',
        reasonCode: 'TEST',
        description: 'test',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });
});
