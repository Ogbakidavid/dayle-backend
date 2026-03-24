import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SetRoleDto } from './dto/set-role.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { UserRole, KycStatus } from '../domain/enums';
import { DiditService } from '../common/services/didit.service';
import { CryptoService } from '../common/services/crypto.service';
import { PartnaService } from '../common/services/partna.service';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private prisma: PrismaService,
    private diditService: DiditService,
    private cryptoService: CryptoService,
    private partnaService: PartnaService,
  ) {}

  async setRole(userId: string, dto: SetRoleDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
    });

    return this.sanitizeUser(updatedUser);
  }

  async submitIdentity(userId: string, dto: SubmitIdentityDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Role must be set first
    if (user.role === UserRole.NONE) {
      throw new BadRequestException({
        code: 'ROLE_NOT_SET',
        message: 'Must set role first',
      });
    }

    // Block other countries
    const normalizedCountry = this.normalizeCountry(dto.country);

    // Block unsupported countries early
    const supportedCountries = ['NG', 'KE', 'NGA', 'KEN'];
    if (normalizedCountry && !supportedCountries.includes(normalizedCountry.toUpperCase())) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_COUNTRY',
        message: "Dayle is currently available in Nigeria and Kenya. We're expanding soon.",
      });
    }

    // Block changing country after KYC is initiated or verified
    if (user.country && user.country !== normalizedCountry && user.kycStatus !== KycStatus.NONE) {
      throw new BadRequestException({
        code: 'COUNTRY_LOCKED',
        message: 'Country cannot be changed after KYC is initiated.',
      });
    }

    const updateData: any = { country: normalizedCountry };

    if (normalizedCountry === 'NG') {
      if (!dto.bvn) {
        throw new BadRequestException('BVN is required for Nigeria');
      }
    } else if (normalizedCountry === 'KE') {
      if (!dto.phoneNumber) {
        throw new BadRequestException('Phone number is required for Kenya');
      }
      updateData.phoneNumber = dto.phoneNumber;
    }

    // Initial update for country/phone
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    try {
      // verifyIdentity will now handle BVN storage ONLY on success
      return await this.verifyIdentity(userId, dto);
    } catch (e) {
      if (e.code === 'P2002') {
        throw new BadRequestException('This BVN is already registered to another account.');
      }
      throw e;
    }
  }

  async submitKyc(userId: string, dto: SubmitKycDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { kycData: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Use stored country if not provided
    const countryToUse = dto.country || user.country;

    // Restrict supported countries
    const supportedCountries = ['NG', 'KE', 'NGA', 'KEN'];
    if (countryToUse && !supportedCountries.includes(countryToUse.toUpperCase())) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_COUNTRY',
        message: "Dayle is currently available in Nigeria and Kenya. We're expanding soon.",
      });
    }

    if (user.role === UserRole.NONE) {
      throw new BadRequestException({
        code: 'ROLE_NOT_SET',
        message: 'Must set role first',
      });
    }

    if (user.kycStatus === KycStatus.VERIFIED) {
      throw new BadRequestException({
        code: 'KYC_ALREADY_VERIFIED',
        message: 'KYC already verified',
      });
    }

    // Construct fields if missing from request but required by DB
    const fullName =
      dto.fullName ||
      (dto.firstName && dto.lastName
        ? `${dto.firstName} ${dto.lastName}`
        : dto.firstName || dto.lastName || 'Unknown User');

    const address = null;
    const idDocumentUrl = null;

    // Update kycStatus and create/update kycData
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: KycStatus.PENDING,
        kycData: {
          upsert: {
            create: {
              fullName: fullName,
              dateOfBirth: new Date(dto.dateOfBirth),
              address: address,
              idDocumentUrl: idDocumentUrl,
              proofOfAddressUrl: dto.proofOfAddressUrl,
              idType: dto.idType,
              idNumber: dto.idNumber,
            },
            update: {
              fullName: fullName,
              dateOfBirth: new Date(dto.dateOfBirth),
              address: address,
              idDocumentUrl: idDocumentUrl,
              proofOfAddressUrl: dto.proofOfAddressUrl,
              idType: dto.idType,
              idNumber: dto.idNumber,
            },
          },
        },
      },
    });

    return this.sanitizeUser(updatedUser);
  }

  async getStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      roleSet: user.role !== UserRole.NONE,
      countrySet: !!user.country,
      identitySet: !!(user.bvn || user.phoneNumber),
      kycVerified: user.kycStatus === KycStatus.VERIFIED,
      emailVerified: user.emailVerified,
      country: user.country,
    };
  }

  async getDiditSession(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Ensure identity is set before KYC
    if (!user.country || !(user.bvn || user.phoneNumber)) {
      throw new BadRequestException({
        code: 'IDENTITY_NOT_SET',
        message: 'Must provide identification details before initiating KYC.',
      });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const callbackUrl = `${baseUrl}/client/settings?didit=success`;

    const sessionResponse = await this.diditService.createSession(
      userId,
      callbackUrl,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: KycStatus.PENDING },
    });

    return {
      sessionId: sessionResponse.session_id,
      url: sessionResponse.url,
    };
  }

  async verifyIdentity(userId: string, dto: SubmitIdentityDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { kycData: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Removed: if (user.kycStatus !== KycStatus.VERIFIED) ...
    // Account generation is now allowed after BVN/Phone submission, before full KYC.

    if (user.paymentAccountReady) {
      return this.sanitizeUser(user);
    }

    // Split name into first and last
    const [firstName = '', ...rest] = user.name.split(' ');
    const lastName = rest.join(' ') || firstName;

    const country = this.normalizeCountry(user.country || '');
    if (country === 'NG') {
      let bvnToUse = dto.bvn || '';

      // If masked BVN is submitted, decrypt and use the stored one
      if (bvnToUse.includes('*') && user.bvn) {
        try {
          bvnToUse = this.cryptoService.decrypt(user.bvn);
        } catch (e) {
          throw new BadRequestException('Invalid stored BVN. Please enter it manually.');
        }
      }

      if (!bvnToUse) throw new BadRequestException('BVN is required');

      try {
        // 1. [PARTNA CUSTOMER REGISTRATION]
        const customerRes = await this.partnaService.createCustomer(
          userId,
          firstName,
          lastName,
          user.email,
          'NG'
        );
        const partnaCustomerId = customerRes.data?.id || customerRes.id;

        if (!partnaCustomerId) {
          throw new Error('Failed to retrieve Partna customer ID');
        }

        // 2. [PARTNA BVN KYC]
        await this.partnaService.initiateBvnKyc(
          bvnToUse,
          firstName,
          lastName,
          user.email,
          partnaCustomerId
        );

        // 3. [PARTNA VIRTUAL ACCOUNT CREATION]
        const accountRes = await this.partnaService.createAccount(partnaCustomerId);

        // 4. Update user ONLY after all Partna steps succeed
        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            bvn: this.cryptoService.encrypt(bvnToUse),
            paymentAccountReady: true,
            partnaCustomerId: partnaCustomerId,
            partnaAccountRef: accountRes.accountRef || accountRes.id || 'REF-PENDING',
          },
        });

        return this.sanitizeUser(updatedUser);
      } catch (e) {
        this.logger.error(`[BVN VERIFICATION FAILED] User ${userId}: ${e.message}`);
        throw new BadRequestException({
          message: "We couldn't verify your BVN. Please check the number and try again.",
          originalError: e.message,
        });
      }
    } else if (country === 'KE') {
      const phoneToUse = dto.phoneNumber || '';
      if (!phoneToUse) throw new BadRequestException('Phone number is required');

      try {
        // [PARTNA PHONE CONFIRM]
        await this.partnaService.confirmPhone(
          phoneToUse,
          firstName,
          lastName,
          user.email,
        );

        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            phoneNumber: phoneToUse,
            paymentAccountReady: true,
          },
        });
        return this.sanitizeUser(updatedUser);
      } catch (err) {
        throw new BadRequestException(
          "We couldn't set up your payment account. Please check your phone number and try again.",
        );
      }
    }

    throw new BadRequestException('Unsupported country for identity verification.');
  }

  // DEV ONLY - Remove before production deployment
  async devBypassIdentity(userId: string) {
    if (process.env.NODE_ENV !== 'development') {
      throw new BadRequestException('Bypass only available in development mode');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        paymentAccountReady: true,
        identityAttempts: 0,
        partnaAccountRef: 'DEV_BYPASS',
      },
    });

    return { message: 'Development bypass applied', user: this.sanitizeUser(updatedUser) };
  }

  private normalizeCountry(c: string): string {
    if (!c) return '';
    const uc = c.toUpperCase();
    if (uc === 'NIGERIA' || uc === 'NGA') return 'NG';
    if (uc === 'KENYA' || uc === 'KEN') return 'KE';
    return uc;
  }

  private sanitizeUser(user: any) {
    if (!user) return null;
    const { passwordHash, updatedAt, bvn, ...result } = user;
    
    if (bvn) {
      try {
        const decryptedBvn = this.cryptoService.decrypt(bvn);
        result.bvn = `*******${decryptedBvn.slice(-4)}`;
      } catch (e) {
        result.bvn = '*******XXXX';
      }
    }
    
    return result;
  }
}
