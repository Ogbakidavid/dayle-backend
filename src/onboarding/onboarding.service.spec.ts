import { Test, TestingModule } from '@nestjs/testing';
import { OnboardingService } from './onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { DiditService } from '../common/services/didit.service';
import { CryptoService } from '../common/services/crypto.service';
import { PartnaService } from '../common/services/partna.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRole, KycStatus } from '../domain/enums';

describe('OnboardingService - submitIdentity', () => {
  let service: OnboardingService;
  let prisma: PrismaService;
  let crypto: CryptoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OnboardingService,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: DiditService,
          useValue: {},
        },
        {
          provide: CryptoService,
          useValue: {
            encrypt: jest.fn().mockReturnValue('encrypted_value'),
            decrypt: jest.fn().mockReturnValue('decrypted_value'),
          },
        },
        {
          provide: PartnaService,
          useValue: {
            createAccount: jest.fn().mockResolvedValue({ success: true }),
            initiateKyc: jest.fn().mockResolvedValue({ success: true }),
            createVirtualAccount: jest.fn().mockResolvedValue({ 
              success: true, 
              data: [{ accountNumber: 'REF-123' }] 
            }),
            confirmPhone: jest.fn().mockResolvedValue({ success: true }),
          },
        },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
    prisma = module.get<PrismaService>(PrismaService);
    crypto = module.get<CryptoService>(CryptoService);
  });

  it("should throw NotFoundException if user does not exist", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.submitIdentity('id', { country: 'NG', bvn: '12345678901' }))
      .rejects.toThrow(NotFoundException);
  });

  it("should throw BadRequestException if role is not set", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'id', role: UserRole.NONE, name: 'Test User', email: 'test@example.com' });
    await expect(service.submitIdentity('id', { country: 'NG', bvn: '12345678901' }))
      .rejects.toThrow(BadRequestException);
  });

  it("should throw BadRequestException for unsupported country", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: 'id', role: UserRole.CLIENT, name: 'Test User', email: 'test@example.com' });
    await expect(service.submitIdentity('id', { country: 'GH' }))
      .rejects.toThrow(BadRequestException);
  });

  it("should successfully submit Nigerian identity (BVN)", async () => {
    const userId = 'fc7b5ce8-1200-45c9-9a17-9853bcfd9bcf';
    const accountName = 'dyfc7b5ce8120045c99a179853bcfd9bcf';
    const dto = { country: 'NG', bvn: '12345678901' };
    
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ 
      id: userId, 
      role: UserRole.CLIENT, 
      kycStatus: KycStatus.NONE, 
      name: 'Test User', 
      email: 'test@example.com', 
      country: 'NG' 
    });
    
    (prisma.user.update as jest.Mock).mockResolvedValue({ 
      id: userId, 
      role: UserRole.CLIENT, 
      kycStatus: KycStatus.NONE, 
      country: 'NG', 
      bvn: 'encrypted_value', 
      name: 'Test User', 
      email: 'test@example.com' 
    });

    const result = await service.submitIdentity(userId, dto);

    expect(crypto.encrypt).toHaveBeenCalledWith('12345678901');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { country: 'NG' },
    });
    
    const partnaService = (service as any).partnaService;
    expect(partnaService.initiateKyc).toHaveBeenCalledWith({
        accountName,
        bvn: '12345678901'
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        bvn: 'encrypted_value',
        paymentAccountReady: true,
        partnaCustomerId: accountName,
        partnaAccountRef: 'REF-123',
      },
    });
  });

  it("should successfully submit Kenyan identity (Phone)", async () => {
    const userId = 'user-2-uuid';
    const accountName = 'dyuser2uuid';
    const dto = { country: 'KE', phoneNumber: '+254712345678' };
    
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ 
      id: userId, 
      role: UserRole.FREELANCER, 
      kycStatus: KycStatus.NONE, 
      name: 'Test User', 
      email: 'test@kenya.com', 
      country: 'KE' 
    });
    
    (prisma.user.update as jest.Mock).mockResolvedValue({ 
      id: userId, 
      role: UserRole.FREELANCER, 
      kycStatus: KycStatus.NONE, 
      country: 'KE', 
      phoneNumber: '+254712345678', 
      name: 'Test User', 
      email: 'test@kenya.com' 
    });

    const result = await service.submitIdentity(userId, dto);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { country: 'KE', phoneNumber: '+254712345678' },
    });

    const partnaService = (service as any).partnaService;
    expect(partnaService.initiateKyc).toHaveBeenCalledWith({
        accountName,
        kesMobileNetwork: 'MPESA',
        kesShortcode: '0712345678'
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        phoneNumber: '+254712345678',
        paymentAccountReady: true,
        partnaCustomerId: accountName,
        partnaAccountRef: 'REF-123',
      },
    });
  });

  it("should prevent changing country if KYC is initiated", async () => {
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ 
      id: 'id', 
      role: UserRole.CLIENT, 
      country: 'NG', 
      kycStatus: KycStatus.PENDING 
    });
    await expect(service.submitIdentity('id', { country: 'KE', phoneNumber: '+254712345678' }))
      .rejects.toThrow(BadRequestException);
  });
});
