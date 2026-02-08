import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { SendVerificationEmailDto } from "./dto/send-verification-email.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { LinkSmartAccountDto } from "./dto/link-smart-account.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { JwtService } from "@nestjs/jwt";
import { PrivyService } from "./privy.service";
import * as bcrypt from "bcrypt";
import { UserRole, KycStatus } from "../domain/enums";

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private privyService: PrivyService,
  ) {}

  async signup(dto: SignupDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException({
        code: "EMAIL_EXISTS",
        message: "Email already registered",
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          name: dto.name,
          role: dto.role || UserRole.NONE,
        },
      });

      // Create Privy Wallet
      const walletData = await this.privyService.createWallet(user.email);

      const wallet = await tx.wallet.create({
        data: {
          userId: user.id,
          address: walletData.address,
          privyDid: walletData.did,
          provider: "PRIVY",
        },
      });

      return { ...user, wallet };
    });

    const user = result;

    const payload = {
      sub: user.id,
      id: user.id,
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      user: this.sanitizeUser(user),
      accessToken: await this.jwtService.signAsync(payload),
      refreshToken: await this.jwtService.signAsync(payload, {
        expiresIn: "30d",
      }),
    };
  }

  async login(dto: LoginDto) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });

      if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
        throw new UnauthorizedException({
          code: "INVALID_CREDENTIALS",
          message: "Email or password incorrect",
        });
      }

      const payload = {
        sub: user.id,
        id: user.id,
        userId: user.id,
        email: user.email,
        role: user.role,
      };

      console.log("About to sanitize user:", user);
      const sanitized = this.sanitizeUser(user);
      console.log("Sanitized user:", sanitized);

      console.log("[AuthService] Signing JWT with payload:", payload);

      return {
        user: sanitized,
        accessToken: await this.jwtService.signAsync(payload),
        refreshToken: await this.jwtService.signAsync(payload, {
          expiresIn: "30d",
        }),
      };
    } catch (error) {
      console.error("Login error:", error);
      throw error;
    }
  }

  async logout(userId: string) {
    // In a real app, you might invalidate the refresh token in the DB
    return { success: true };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "User not found",
      });
    }

    return this.sanitizeUser(user);
  }

  async verifyEmail(dto: VerifyEmailDto) {
    // Simplified logic: mark email as verified for any valid-looking token
    // In a real app, you would verify the token against a database or signature
    const user = await this.prisma.user.updateMany({
      where: { emailVerified: false }, // This is just a placeholder
      data: { emailVerified: true },
    });

    return { success: true };
  }

  async sendVerificationEmail(dto: SendVerificationEmailDto) {
    // Find user by email
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      // Return success even if user not found (security best practice)
      return { success: true, message: "If the email exists, a verification link has been sent." };
    }

    if (user.emailVerified) {
      return { success: true, message: "Email already verified." };
    }

    // In a real app, you would:
    // 1. Generate a verification token
    // 2. Store it in the database with expiration
    // 3. Send an email with the verification link
    // For now, we'll just return success
    return { success: true, message: "Verification email sent." };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        name: dto.name,
        profileImage: dto.profileImage,
      },
    });

    return this.sanitizeUser(user);
  }

  async socialLogin(accessToken: string) {
    let verifiedClaims;
    try {
      verifiedClaims = await this.privyService.verifyToken(accessToken);
    } catch (error) {
      console.error("Token verification failed:", error);
      throw new UnauthorizedException("Invalid auth token");
    }

    const { userId: did } = verifiedClaims;
    
    // Fetch full user details from Privy to get email/name if available in the token verification response doesn't have it all
    // verifiedClaims usually contains minimal info. Let's fetch the full user.
    const privyUser = await this.privyService.getUser(did);
    // Extract email from various possible locations in Privy user object
    let email = privyUser.email ? privyUser.email.address : null;
    let name = "";

    if (!email) {
      if ((privyUser as any).google?.email) {
        email = (privyUser as any).google.email;
        name = (privyUser as any).google.name;
      } else if ((privyUser as any).github?.email) {
        email = (privyUser as any).github.email;
        name = (privyUser as any).github.name;
      } else if ((privyUser as any).apple?.email) {
        email = (privyUser as any).apple.email;
      } else if (privyUser.linkedAccounts) {
        const googleAccount = privyUser.linkedAccounts.find(
          (acc) => acc.type === "google_oauth",
        );
        const githubAccount = privyUser.linkedAccounts.find(
          (acc) => acc.type === "github_oauth",
        );
        
        if (googleAccount) {
            email = (googleAccount as any).email;
            name = (googleAccount as any).name;
        } else if (githubAccount) {
            email = (githubAccount as any).email;
            name = (githubAccount as any).name;
        }
      }
    }

    if (!email) {
      console.error("Privy User missing email:", JSON.stringify(privyUser));
      throw new BadRequestException("Email is required from social login");
    }

    // Fallback for name
    if (!name) {
        name = email.split("@")[0];
    }

    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email }, { wallet: { privyDid: did } }],
      },
      include: { wallet: true },
    });

    if (!user) {
      // Create new user if not found
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            name,
            passwordHash: "", // No password for social users
            role: UserRole.NONE,
            emailVerified: true,
          },
        });

        await tx.wallet.create({
          data: {
            userId: newUser.id,
            address: privyUser.wallet ? privyUser.wallet.address : "", 
            privyDid: did,
            provider: "PRIVY",
          },
        });

        return tx.user.findUnique({
          where: { id: newUser.id },
          include: { wallet: true },
        });
      });
    } else if (!user.wallet) {
      // Link existing user to Privy if not linked
      await this.prisma.wallet.create({
        data: {
          userId: user.id,
          address: privyUser.wallet ? privyUser.wallet.address : "",
          privyDid: did,
          provider: "PRIVY",
        },
      });
      user = await this.prisma.user.findUnique({
        where: { id: user.id },
        include: { wallet: true },
      });
    }

    if (!user) {
      throw new UnauthorizedException("Failed to synchronize user account");
    }

    const payload = {
      sub: user.id,
      id: user.id,
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      user: this.sanitizeUser(user),
      accessToken: await this.jwtService.signAsync(payload),
      refreshToken: await this.jwtService.signAsync(payload, {
        expiresIn: "30d",
      }),
    };
  }

  async linkSmartAccount(userId: string, dto: LinkSmartAccountDto) {
    // Logic to link smart account (Privy/Web3Auth)
    // For now, we'll just return a success response as per the contract
    return {
      id: "sa_" + Math.random().toString(36).substr(2, 9),
      address: dto.address,
      provider: dto.provider,
      status: "ACTIVE",
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("User not found or using social login");
    }

    const isPasswordValid = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException("Current password incorrect");
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    return { success: true };
  }

  // Session Management (Mock Implementation)
  async getSessions(userId: string) {
    return [
      {
        id: "sess_current",
        ip: "127.0.0.1",
        device: "Current Device",
        lastActive: new Date().toISOString(),
        current: true,
      },
    ];
  }

  async revokeSession(userId: string, sessionId: string) {
    if (sessionId === "sess_current") {
      throw new BadRequestException("Cannot revoke current session");
    }
    return { success: true };
  }

  async revokeAllSessions(userId: string) {
    return { success: true, revokedCount: 0 };
  }

  // 2FA Management
  async enable2FA(userId: string) {
    const secret = "MOCK_SECRET_" + Math.random().toString(36).substr(2, 9).toUpperCase();
    return {
      secret,
      qrCodeUrl: `otpauth://totp/Dayle?secret=${secret}&issuer=Dayle`,
      recoveryCodes: ["ABCD-1234", "EFGH-5678", "IJKL-9012"],
      tempSecret: secret,
    };
  }

  async verify2FA(userId: string, code: string, tempSecret: string) {
    if (code !== "123456") throw new BadRequestException("Invalid 2FA code");

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: true, twoFactorSecret: tempSecret },
    });

    return { success: true };
  }

  async disable2FA(userId: string, code: string) {
    if (code !== "123456") throw new BadRequestException("Invalid 2FA code");

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFaEnabled: false, twoFactorSecret: null },
    });

    return { success: true };
  }

  async get2FAStatus(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return { enabled: user?.twoFaEnabled || false };
  }

  async verify2FAOnLogin(email: string, code: string) {
    if (code !== "123456") throw new BadRequestException("Invalid 2FA code");

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.twoFaEnabled) {
      throw new BadRequestException("2FA not enabled for this user");
    }

    return { success: true };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, twoFactorSecret, ...rest } = user;
    return rest;
  }
}
