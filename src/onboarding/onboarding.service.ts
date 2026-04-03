import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
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

  async initializePartnaAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const accountName = userId.replace(/-/g, '').toLowerCase();

    try {
      this.logger.log(
        `[INITIALIZE PARTNA ACCOUNT] User ${userId}, accountName: ${accountName}`,
      );
      // Create the Partna account/profile
      await this.partnaService.createAccount(accountName, user.email);

      // Store the accountName as partnaCustomerId immediately
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { partnaCustomerId: accountName },
      });

      return { success: true, partnaCustomerId: accountName };
    } catch (e) {
      this.logger.error(
        `[PARTNA ACCOUNT INITIALIZATION FAILED] User ${userId}: ${e.message}`,
      );
      // Handle "already exists" elegantly - often returns 400 or has specific msg
      if (e.message.includes('exists')) {
        return {
          success: true,
          partnaCustomerId: accountName,
          note: 'Already exists',
        };
      }
      throw e;
    }
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
    if (
      normalizedCountry &&
      !supportedCountries.includes(normalizedCountry.toUpperCase())
    ) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_COUNTRY',
        message:
          "Dayle is currently available in Nigeria and Kenya. We're expanding soon.",
      });
    }

    // Block changing country after KYC is initiated or verified
    if (
      user.country &&
      user.country !== normalizedCountry &&
      user.kycStatus !== KycStatus.NONE
    ) {
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
        throw new BadRequestException(
          'This BVN is already registered to another account.',
        );
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
    if (
      countryToUse &&
      !supportedCountries.includes(countryToUse.toUpperCase())
    ) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_COUNTRY',
        message:
          "Dayle is currently available in Nigeria and Kenya. We're expanding soon.",
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

    const country = this.normalizeCountry(user.country || '');
    // Using a prefix 'dy' (strictly alphanumeric) to ensure dayle-specific account names
    const accountName = `dy${userId.replace(/-/g, '').toLowerCase()}`;

    if (country === 'NG') {
      let bvnToUse = dto.bvn || '';

      // If masked BVN is submitted, decrypt and use the stored one
      if (bvnToUse.includes('*') && user.bvn) {
        try {
          bvnToUse = this.cryptoService.decrypt(user.bvn);
        } catch (e) {
          throw new BadRequestException(
            'Invalid stored BVN. Please enter it manually.',
          );
        }
      }

      if (!bvnToUse) throw new BadRequestException('BVN is required');

      try {
        // 1. [PARTNA PROFILE CREATION & RECOVERY]
        let finalAccountName = accountName;
        try {
          await this.partnaService.createAccount(finalAccountName, user.email);
        } catch (e: any) {
          if (e.message.includes('exists')) {
            this.logger.warn(
              `[PARTNA COLLISION] Email ${user.email} already exists. Attempting recovery...`,
            );
            // RECOVERY: List accounts and find the one that matches this email
            const accounts = await this.partnaService.getAccountDetails();
            const existing = accounts.find(
              (acc: any) =>
                (acc.email || '').toLowerCase() === user.email.toLowerCase(),
            );

            if (existing) {
              finalAccountName = (existing.externalRef ||
                existing.account_name ||
                existing.accountName) as string;
              this.logger.log(
                `[PARTNA RECOVERY] Successfully recovered accountName: ${finalAccountName} for ${user.email}`,
              );
            } else {
              this.logger.error(
                `[PARTNA RECOVERY FAILED] Collision reported but email ${user.email} not found in account list.`,
              );
              throw new BadRequestException(
                'This email is already registered on Partna under a different ID. Please use a fresh email address.',
              );
            }
          } else {
            throw e;
          }
        }

        // 2. [PARTNA BVN KYC]
        const kycRes = await this.partnaService.initiateKyc({
          accountName: finalAccountName,
          bvn: bvnToUse,
        });

        // 3. [CHECK FOR OTP REQUIREMENT]
        // Partna v4 might return verification methods if OTP is needed
        if (kycRes.data?.methods) {
          this.logger.log(
            `[PARTNA KYC] OTP required for user ${userId}. Methods: ${JSON.stringify(kycRes.data.methods)}`,
          );
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              bvn: this.cryptoService.encrypt(bvnToUse),
              partnaCustomerId: finalAccountName,
            },
          });
          return {
            requiresOtp: true,
            methods: kycRes.data.methods,
          };
        }

        // 4. [PARTNA VIRTUAL ACCOUNT CREATION]
        // If no methods returned, assume KYC succeeded or is instant
        const accountRes = await this.partnaService.createVirtualAccount(
          finalAccountName,
          'NGN',
        );
        const accountData = accountRes.data?.[0] || accountRes.data || {};

        // 5. Update user ONLY after all Partna steps succeed
        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            bvn: this.cryptoService.encrypt(bvnToUse),
            paymentAccountReady: true,
            partnaCustomerId: finalAccountName,
            partnaAccountRef:
              (accountData as any).accountNumber ||
              (accountData as any).id ||
              'REF-PENDING',
          },
        });

        return this.sanitizeUser(updatedUser);
      } catch (e) {
        this.logger.error(
          `[BVN VERIFICATION FAILED] User ${userId}: ${e.message}`,
        );

        // Handle Partna specific error: "maximum kyc lookup attempts reached"
        if (e.message.includes('maximum kyc lookup attempts reached')) {
          throw new BadRequestException({
            code: 'KYC_LOOKUP_LIMIT_REACHED',
            message:
              "You've reached the maximum number of verification attempts. Please contact support via Slack to reset your account.",
            originalError: e.message,
          });
        }

        if (e.message.includes('Account not found')) {
          throw new BadRequestException(
            e.message ||
              'Partna account initialization failed. This often happens if your email is already registered with a different account on Partna.',
          );
        }

        throw new BadRequestException(
          e.message ||
            "We couldn't verify your BVN. Please check the number and try again.",
        );
      }
    } else if (country === 'KE') {
      const phoneToUse = dto.phoneNumber || '';
      if (!phoneToUse)
        throw new BadRequestException('Phone number is required');

      try {
        // 1. [PARTNA PROFILE CREATION & RECOVERY]
        let finalAccountName = accountName;
        try {
          await this.partnaService.createAccount(finalAccountName, user.email);
        } catch (e: any) {
          if (e.message.includes('exists')) {
            const accounts = await this.partnaService.getAccountDetails();
            const existing = accounts.find(
              (acc: any) =>
                (acc.email || '').toLowerCase() === user.email.toLowerCase(),
            );
            if (existing) {
              finalAccountName = (existing.externalRef ||
                existing.account_name ||
                existing.accountName) as string;
            }
          } else {
            throw e;
          }
        }

        // 2. [PARTNA PHONE KYC]
        // Sanitize phone for Kenya: +254712345678 -> 0712345678 (10 digits)
        const sanitizedPhone = phoneToUse.replace('+254', '0');

        const kycRes = await this.partnaService.initiateKyc({
          accountName: finalAccountName,
          kesMobileNetwork: 'MPESA',
          kesShortcode: sanitizedPhone,
        });

        // 3. [CHECK FOR OTP REQUIREMENT]
        if (kycRes.data?.methods) {
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              phoneNumber: phoneToUse,
              partnaCustomerId: finalAccountName,
            },
          });
          return {
            requiresOtp: true,
            methods: kycRes.data.methods,
          };
        }

        // 4. [PARTNA VIRTUAL ACCOUNT CREATION]
        // Create KES virtual account
        const accountRes = await this.partnaService
          .createVirtualAccount(finalAccountName, 'KES')
          .catch((err) => {
            this.logger.warn(
              `[KE VIRTUAL ACCOUNT FAILED] ${err.message}. This might be expected if KES accounts are manual.`,
            );
            return { data: [] };
          });
        const accountData = accountRes.data?.[0] || accountRes.data || {};

        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            phoneNumber: phoneToUse,
            paymentAccountReady: true,
            partnaCustomerId: finalAccountName,
            partnaAccountRef:
              (accountData as any).accountNumber ||
              (accountData as any).id ||
              'REF-KE-PENDING',
          },
        });
        return this.sanitizeUser(updatedUser);
      } catch (err) {
        this.logger.error(
          `[PHONE VERIFICATION FAILED] User ${userId}: ${err.message}`,
        );
        throw new BadRequestException(
          "We couldn't set up your payment account. Please check your phone number and try again.",
        );
      }
    }

    throw new BadRequestException(
      'Unsupported country for identity verification.',
    );
  }

  async selectKycMethod(userId: string, method: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.partnaCustomerId)
      throw new BadRequestException('KYC session not started');

    const currency = user.country === 'KE' ? 'KES' : 'NGN';
    try {
      return await this.partnaService.selectKycMethod(
        user.partnaCustomerId,
        method,
        currency,
      );
    } catch (err: any) {
      this.logger.error(`[KYC METHOD ERROR] ${err.message}`);
      throw new BadRequestException(err.message);
    }
  }

  async verifyKycOtp(userId: string, otp: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.partnaCustomerId)
      throw new BadRequestException('KYC session not started');

    // 1. Verify OTP with Partna
    const currency = user.country === 'KE' ? 'KES' : 'NGN';
    try {
      await this.partnaService.verifyKycOtp(
        user.partnaCustomerId,
        otp,
        currency,
      );
    } catch (err: any) {
      this.logger.error(`[KYC OTP ERROR] ${err.message}`);
      throw new BadRequestException(err.message);
    }

    // 2. Step 6: Create Virtual Account after successful verification (using PUT /v4/account)
    const accountRes = await this.partnaService
      .createVirtualAccount(user.partnaCustomerId, currency)
      .catch((err) => {
        this.logger.error(`[STEP 6 VIRTUAL ACCOUNT FAILED] ${err.message}`);
        throw new BadRequestException(
          `KYC verified but virtual account creation failed: ${err.message}`,
        );
      });

    // 3. Mark user as ready and store reference
    const accountData = accountRes.data?.[0] || accountRes.data || {};
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        paymentAccountReady: true,
        partnaAccountRef:
          (accountData as any).accountNumber ||
          (accountData as any).id ||
          'REF-POST-OTP',
      },
    });

    return this.sanitizeUser(updatedUser);
  }
  async confirmKycPhone(userId: string, phone: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.partnaCustomerId)
      throw new BadRequestException('KYC session not started');

    try {
      return await this.partnaService.confirmPhone(
        user.partnaCustomerId,
        phone,
      );
    } catch (err: any) {
      this.logger.error(`[KYC PHONE CONFIRM ERROR] ${err.message}`);
      throw new BadRequestException(err.message);
    }
  }

  // DEV ONLY - Remove before production deployment
  async devBypassIdentity(userId: string) {
    if (process.env.ENABLE_DEV_BYPASS !== 'true') {
      throw new ForbiddenException(
        'Identity bypass is not available in this environment',
      );
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        paymentAccountReady: true,
        identityAttempts: 0,
        partnaAccountRef: 'DEV_BYPASS',
      },
    });

    return {
      message: 'Development bypass applied',
      user: this.sanitizeUser(updatedUser),
    };
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
