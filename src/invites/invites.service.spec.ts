import { Test, TestingModule } from '@nestjs/testing';
import { InvitesService } from './invites.service';
import { PrismaService } from '../prisma/prisma.service';

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
      ],
    }).compile();

    service = module.get<InvitesService>(InvitesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
