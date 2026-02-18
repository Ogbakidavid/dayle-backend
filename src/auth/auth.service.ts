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



    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          role: dto.role || UserRole.NONE,
          emailVerified: false,
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

      if (!user) {
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

      const accessToken = await this.jwtService.signAsync(payload);
      const refreshToken = await this.jwtService.signAsync(payload, { expiresIn: "30d" });
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

      // Create Session
      await this.prisma.session.create({
        data: {
          userId: user.id,
          accessToken,
          refreshToken,
          expiresAt,
        }
      });

      return {
        user: sanitized,
        accessToken,
        refreshToken,
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
      include: { wallet: true },
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

  async resendVerificationEmail(userId: string) {
      const user = await this.prisma.user.findUnique({
          where: { id: userId },
      });

      if (!user) {
          throw new UnauthorizedException("User not found");
      }

      if (user.emailVerified) {
          return { success: true, message: "Email already verified" };
      }

      // Logic to resend email (mock)
      return { success: true, message: "Verification email resent" };
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

  async privyLogin(accessToken: string, role?: string) {
    let verifiedClaims: any;
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

    // Check for existing user by email or wallet DID
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { wallet: true },
    });

    if (!user) {
        // If not found by email, try finding by wallet DID (if they changed email in social provider but DID is same? Unlikely for social login but good for safety)
        // Actually, for social login, email is the primary connector.
        // Let's stick to email first. 
        // If we want to support finding by wallet, we need to know if wallet is unique enough or if we have it.
        const wallet = await this.prisma.wallet.findFirst({
            where: { privyDid: did },
            include: { user: true }
        });
        if (wallet && wallet.user) {
            user = wallet.user as any; 
            // We found them by wallet, but email might have changed or is different. 
            // For now, let's assume if found by wallet, it's them.
        }
    }

    if (!user) {
      // Validate role if provided
      const userRole = role && Object.values(UserRole).includes(role as UserRole) ? (role as UserRole) : UserRole.NONE;

      // Create new user if not found
      user = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            email,
            name,
            role: userRole,
            emailVerified: true,
          },
        });

        // Check if Privy user has an embedded wallet
        const embeddedWallet = privyUser.linkedAccounts.find(
          (account) =>
            account.type === "wallet" && account.walletClientType === "privy",
        );
        
        // With createOnLogin: 'all-users', the wallet SHOULD exist.
        // If not, we might need to handle it, but for now we assume it exists or use a placeholder
        // that indicates it needs sync. 
        // Note: address is required and unique in schema.
        
        const walletAddress = embeddedWallet ? (embeddedWallet as any).address : "";
        
        if (!walletAddress) {
            console.warn(`Privy User ${did} has no wallet address during signup.`);
             // We can throw here, or continue and try to create one?
             // Since we switched to 'all-users', we expect it.
        }

        // Check if a wallet with this DID already exists (orphaned wallet case)
        const existingWallet = await tx.wallet.findUnique({
          where: { privyDid: did },
        });

        if (existingWallet) {
             // Link the existing orphaned wallet to the new user
             await tx.wallet.update({
               where: { id: existingWallet.id },
               data: {
                 userId: newUser.id,
                 address: walletAddress || existingWallet.address, // Update address if we have a better one, or keep existing
                 provider: "PRIVY",
               },
             });
        } else {
             await tx.wallet.create({
               data: {
                 userId: newUser.id,
                 address: walletAddress || `pending_${did}`,
                 privyDid: did,
                 provider: "PRIVY",
               },
             });
        }

        return tx.user.findUnique({
          where: { id: newUser.id },
          include: { wallet: true },
        });
      });
    } else if (!user.wallet) {
      // Link existing user to Privy if not linked
      // Check if wallet for this DID already exists to avoid unique constraint error
      const existingWallet = await this.prisma.wallet.findFirst({ where: { privyDid: did } });
      
      if (!existingWallet) {
          const embeddedWallet = privyUser.wallet;
          const walletAddress = embeddedWallet ? embeddedWallet.address : `pending_${did}`;

          await this.prisma.wallet.create({
            data: {
              userId: user.id,
              address: walletAddress,
              privyDid: did,
              provider: "PRIVY",
            },
          });
      } else {
          // Wallet exists but not linked to this user? This is weird state. 
          // Maybe update wallet to point to this user if it's orphaned?
          // Or just log it.
          console.warn(`Wallet with DID ${did} exists but user ${user.id} has no wallet linked. Linking now if possible.`);
          // If the wallet entry exists, it points to A user. 
          // If it points to THIS user, then user.wallet should have been set.
          // If it points to another user, we have a conflict.
      }

      // Refresh user object
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
    // Password change functionality removed as we rely on Privy
    throw new BadRequestException("Password management is handled by Privy/Social providers");
  }

  // Session Management
  async getSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    await this.prisma.session.deleteMany({
      where: { id: sessionId, userId }
    });
    return { success: true };
  }

  async revokeAllSessions(userId: string) {
    const result = await this.prisma.session.deleteMany({
      where: { userId }
    });
    return { success: true, revokedCount: result.count };
  }

  async get2FAStatus(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return { enabled: user?.twoFaEnabled || false };
  }

  private sanitizeUser(user: any) {
    const { twoFactorSecret, ...rest } = user;
    return rest;
  }
}
