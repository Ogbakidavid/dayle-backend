import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { JwtService } from "@nestjs/jwt";
import { PrivyService } from "./privy.service";
import { UserRole } from "../domain/enums";

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private privyService: PrivyService,
  ) {}

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
        // If not found by email, try finding by wallet DID
        const wallet = await this.prisma.wallet.findFirst({
            where: { privyDid: did },
            include: { user: true }
        });
        if (wallet && wallet.user) {
            user = wallet.user as any; 
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
        
        const walletAddress = embeddedWallet ? (embeddedWallet as any).address : "";
        
        if (!walletAddress) {
            console.warn(`Privy User ${did} has no wallet address during signup.`);
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
                 address: walletAddress || existingWallet.address, 
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
      const existingWallet = await this.prisma.wallet.findFirst({ where: { privyDid: did } });
      
      if (!existingWallet) {
          const embeddedWallet = privyUser.linkedAccounts?.find(
             (account) => account.type === "wallet" && account.walletClientType === "privy"
          );
          const walletAddress = embeddedWallet ? (embeddedWallet as any).address : `pending_${did}`;

          await this.prisma.wallet.create({
            data: {
              userId: user.id,
              address: walletAddress,
              privyDid: did,
              provider: "PRIVY",
            },
          });
      } else {
          console.warn(`Wallet with DID ${did} exists but user ${user.id} has no wallet linked. Linking now if possible.`);
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

    const accessTokenJwt = await this.jwtService.signAsync(payload);
    const refreshTokenJwt = await this.jwtService.signAsync(payload, { expiresIn: "30d" });

    // Create Session
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); 

    await this.prisma.session.create({
      data: {
        userId: user.id,
        accessToken: accessTokenJwt,
        refreshToken: refreshTokenJwt,
        expiresAt,
      }
    });

    return {
      user: this.sanitizeUser(user),
      accessToken: accessTokenJwt,
      refreshToken: refreshTokenJwt,
    };
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
