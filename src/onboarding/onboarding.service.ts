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

    const accountName = `dy${userId.replace(/-/g, '').toLowerCase()}`;
    
    // Check if email already exists on Partna first
    try {
      const existing = await this.partnaService.findAccountByEmail(user.email);
      
      if (existing) {
        const recoveredName = existing.externalRef || existing.accountName || existing.account_name;
        await this.prisma.user.update({
          where: { id: userId },
          data: { partnaCustomerId: String(recoveredName) },
        });
        return { success: true, partnaCustomerId: String(recoveredName), note: 'Recovered existing account' };
      }
    } catch (e) {
      this.logger.warn(`[PARTNA INIT LOOKUP] Could not check existing accounts: ${e.message}`);
    }

    try {
      this.logger.log(
        `[INITIALIZE PARTNA ACCOUNT] User ${userId}, accountName: ${accountName}`,
      );
      // No existing account found or lookup failed — create the Partna account/profile
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
      // Handle "already exists" elegantly
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

    const updateData: any = { 
      country: normalizedCountry,
      name: dto.fullName 
    };

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

    // Initial update for country/phone/name
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
        let finalAccountName = accountName; // accountName = `dy${userId...}`

        // FIRST: Check if this email already has a Partna account
        // This handles DB wipe / re-registration scenarios
        try {
          const existingAccount = await this.partnaService.findAccountByEmail(user.email);
          
          if (existingAccount) {
            // Email already registered on Partna — recover the existing externalRef
            finalAccountName = String(existingAccount.externalRef || existingAccount.accountName || existingAccount.account_name);
            this.logger.log(`[PARTNA RECOVERY] Existing account found for ${user.email}. Using externalRef: ${finalAccountName}`);
            
            // Update DB immediately so partnaCustomerId is correct going forward
            await this.prisma.user.update({
              where: { id: userId },
              data: { partnaCustomerId: finalAccountName },
            });
          } else {
            // No existing account — create new one
            try {
              const accountRes = await this.partnaService.createAccount(
                finalAccountName,
                user.email,
                user.name,
              );
              finalAccountName =
                (accountRes.data as any).accountName || finalAccountName;
            } catch (e: any) {
              if (!e.message.includes('exists')) throw e;
              // If still conflicts, do one more thorough lookup
              const retryMatch = await this.partnaService.findAccountByEmail(user.email);
              if (retryMatch) {
                finalAccountName = String(retryMatch.externalRef || retryMatch.accountName || retryMatch.account_name);
                this.logger.log(`[PARTNA RECOVERY RETRY] Recovered: ${finalAccountName}`);
              }
            }
          }
        } catch (lookupError: any) {
          this.logger.error(`[PARTNA LOOKUP FAILED] ${lookupError.message}. Proceeding with new account creation.`);
          // Fallback: try creating the account directly
          try {
            await this.partnaService.createAccount(
              finalAccountName,
              user.email,
              user.name,
            );
          } catch (e: any) {
            if (!e.message.includes('exists')) throw e;
          }
        }

        // 2. [PARTNA BVN KYC]
        let kycRes: any = null;
        try {
          kycRes = await this.partnaService.initiateKyc({
            accountName: finalAccountName,
            bvn: bvnToUse,
          });
        } catch (kycError: any) {
          // "kyc previously completed" means this user is already verified on Partna
          // Treat as success — skip to virtual account creation
          if (
            kycError.message?.toLowerCase().includes('kyc previously completed') ||
            kycError.message?.toLowerCase().includes('previously completed')
          ) {
            this.logger.log(
              `[PARTNA KYC] KYC already completed for ${finalAccountName}. Proceeding to virtual account.`
            );
            kycRes = { data: null }; // Signal to skip OTP step
          } else {
            throw kycError; // Real error — rethrow
          }
        }

        // 3. [CHECK FOR OTP REQUIREMENT]
        // Only enter OTP flow if Partna returned methods AND kyc wasn't already done
        if (kycRes?.data?.methods) {
          this.logger.log(
            `[PARTNA KYC] OTP required for user ${userId}. Methods: ${JSON.stringify(kycRes.data.methods)}`
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
        // Reaches here if: KYC succeeded instantly OR kyc previously completed
        const accountCreateRes = await this.partnaService
          .createVirtualAccount(finalAccountName, 'NGN')
          .catch((err: any) => {
            if (
              err.message?.toLowerCase().includes('already exists') ||
              err.message?.toLowerCase().includes('account exists')
            ) {
              this.logger.log(`[PARTNA VIRTUAL ACCOUNT] Already exists for ${finalAccountName}. Treating as success.`);
              return { data: { accountNumber: 'REF-EXISTING', id: 'REF-EXISTING' } };
            }
            throw err;
          });
        const accountData = accountCreateRes.data?.[0] || accountCreateRes.data || {};

        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            bvn: this.cryptoService.encrypt(bvnToUse),
            paymentAccountReady: true,
            partnaCustomerId: finalAccountName,
            partnaAccountRef: String(
              (accountData as any).accountNumber ||
              (accountData as any).id ||
              'REF-PENDING'
            ),
            kycStatus: 'VERIFIED',
          },
        });

        return this.sanitizeUser(updatedUser);
      } catch (e) {
        this.logger.error(`[BVN VERIFICATION FAILED] User ${userId}: ${e.message}`);
        throw new BadRequestException(e.message || "Verification failed.");
      }
    } else if (country === 'KE') {
      const phoneToUse = dto.phoneNumber || '';
      if (!phoneToUse)
        throw new BadRequestException('Phone number is required');

      try {
        // 1. [PARTNA PROFILE CREATION & RECOVERY - KENYA]
        let finalAccountName = accountName; // accountName = `dy${userId...}`

        // Check if email already has a Partna account before creating
        try {
          const existingAccount = await this.partnaService.findAccountByEmail(user.email);

          if (existingAccount) {
            finalAccountName = String(existingAccount.externalRef || existingAccount.accountName || existingAccount.account_name);
            this.logger.log(`[PARTNA KE RECOVERY] Existing account found for ${user.email}. Using externalRef: ${finalAccountName}`);

            // Update DB immediately so partnaCustomerId is correct
            await this.prisma.user.update({
              where: { id: userId },
              data: { partnaCustomerId: finalAccountName },
            });
          } else {
            // No existing account — create new
            try {
              await this.partnaService.createAccount(
                finalAccountName,
                user.email,
                user.name,
              );
            } catch (e: any) {
              if (!e.message.includes('exists')) throw e;
              // Race condition fallback - thorough search
              const retryMatch = await this.partnaService.findAccountByEmail(user.email);
              if (retryMatch) {
                finalAccountName = String(
                  retryMatch.externalRef ||
                    retryMatch.accountName ||
                    retryMatch.account_name,
                );
                this.logger.log(
                  `[PARTNA KE RECOVERY RETRY] Recovered: ${finalAccountName}`,
                );
              }
            }
          }
        } catch (lookupError: any) {
          this.logger.error(
            `[PARTNA KE LOOKUP FAILED] ${lookupError.message}. Proceeding with new account.`,
          );
          try {
            await this.partnaService.createAccount(
              finalAccountName,
              user.email,
              user.name,
            );
          } catch (e: any) {
            if (!e.message.includes('exists')) throw e;
          }
        }

        // 2. [PARTNA PHONE KYC - KENYA]
        let phoneRes: any = null;
        try {
          const sanitizedPhone = phoneToUse.replace('+254', '0');
          phoneRes = await this.partnaService.initiatePhoneVerification({
            country: 'KE',
            accountName: finalAccountName,
            phoneNumber: sanitizedPhone,
            mobileNetwork: 'Safaricom', // Default for Kenya
          });
        } catch (phoneError: any) {
          this.logger.error(`[PARTNA KE PHONE VERIFY FAILED] ${phoneError.message}`);
          throw phoneError;
        }

        // 3. [SELECT VERIFICATION METHOD & STORE phoneID]
        if (phoneRes?.data?.phoneID) {
          const phoneID = phoneRes.data.phoneID;
          await this.partnaService.selectPhoneVerificationMethod(phoneID);

          await this.prisma.user.update({
            where: { id: userId },
            data: {
              phoneNumber: phoneToUse,
              partnaCustomerId: finalAccountName,
              partnaAccountRef: phoneID, // Temporarily store phoneID here for Kenya
            },
          });

          return {
            requiresOtp: true,
            methods: [{ type: 'SMS', value: phoneToUse }], // Partna v4 phone flow implicitly uses SMS
          };
        }

        // 4. [PARTNA VIRTUAL ACCOUNT CREATION]
        const accountRes = await this.partnaService
          .createVirtualAccount(finalAccountName, 'KES')
          .catch((err: any) => {
            if (
              err.message?.toLowerCase().includes('already exists') ||
              err.message?.toLowerCase().includes('account exists')
            ) {
              this.logger.log(`[PARTNA KE VIRTUAL ACCOUNT] Already exists for ${finalAccountName}.`);
              return { data: { accountNumber: 'REF-EXISTING', id: 'REF-EXISTING' } };
            }
            throw err;
          });
        const accountData = accountRes.data?.[0] || accountRes.data || {};

        const updatedUser = await this.prisma.user.update({
          where: { id: userId },
          data: {
            phoneNumber: phoneToUse,
            paymentAccountReady: true,
            partnaCustomerId: finalAccountName,
            partnaAccountRef: String(
              (accountData as any).accountNumber ||
              (accountData as any).id ||
              'REF-KE-PENDING'
            ),
            kycStatus: 'VERIFIED',
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
      if (currency === 'KES') {
        // Use new /phone/confirm for Kenya
        if (!user.partnaAccountRef) {
          throw new BadRequestException('Phone ID missing for Kenya verification');
        }
        await this.partnaService.confirmPhoneOtp(user.partnaAccountRef, otp);
      } else {
        await this.partnaService.verifyKycOtp(
          user.partnaCustomerId,
          otp,
          currency,
        );
      }
    } catch (err: any) {
      this.logger.error(`[KYC OTP ERROR] ${err.message}`);
      throw new BadRequestException(err.message);
    }

    // 2. Step 6: Create Virtual Account after successful verification (using PUT /v4/account)
    // For Kenya, we might still want this or just use the phoneID
    const accountRes = await this.partnaService
      .createVirtualAccount(user.partnaCustomerId, currency)
      .catch((err) => {
        // Non-critical for Kenya if phone verification succeeded
        this.logger.error(`[STEP 6 VIRTUAL ACCOUNT FAILED] ${err.message}`);
        if (currency !== 'KES') {
          throw new BadRequestException(
            `KYC verified but virtual account creation failed: ${err.message}`,
          );
        }
        return { data: { accountNumber: user.partnaAccountRef } };
      });

    // 3. Mark user as ready and store reference
    const accountData = accountRes.data?.[0] || accountRes.data || {};
    const finalAccountRef =
      currency === 'KES'
        ? user.partnaAccountRef // Preserve phoneID for Kenya
        : (accountData as any).accountNumber ||
          (accountData as any).id ||
          'REF-POST-OTP';

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        paymentAccountReady: true,
        kycStatus: KycStatus.VERIFIED,
        partnaAccountRef: finalAccountRef,
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
