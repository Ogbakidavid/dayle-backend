import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtService } from '@nestjs/jwt';
import { PrivyService } from './privy.service';
import { UserRole } from '../domain/enums';

import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private privyService: PrivyService,
    private redis: RedisService,
  ) {}

  async privyLogin(accessToken: string, role?: string) {
    let verifiedClaims: any;
    try {
      verifiedClaims = await this.privyService.verifyToken(accessToken);
    } catch (error) {
      console.error('Token verification failed:', error);
      throw new UnauthorizedException('Invalid auth token');
    }

    const claims = verifiedClaims;
    const privyDid = claims.user_id || claims.userId || claims.sub;
    console.log(
      '[privyLogin] Step 1: Token verified. DID:',
      privyDid,
      '| All claim keys:',
      Object.keys(claims),
    );

    if (!privyDid) {
      throw new UnauthorizedException(
        'Could not extract user ID from Privy token',
      );
    }

    // Fetch full user details from Privy
    const privyUser = await this.privyService.getUser(privyDid);
    // REST API returns snake_case, old SDK returned camelCase — handle both
    const linkedAccounts: any[] =
      privyUser.linked_accounts || privyUser.linkedAccounts || [];
    console.log(
      '[privyLogin] Step 2: Got Privy user. linked_accounts count:',
      linkedAccounts.length,
      '| Full user:',
      JSON.stringify(privyUser),
    );

    // Extract email — check all possible locations
    let email: string | null = null;
    let name = '';

    // 1. Top-level email field (REST API sometimes returns this directly)
    if (privyUser.email) {
      const emailField = privyUser.email;
      email =
        typeof emailField === 'string'
          ? emailField
          : emailField.address || null;
    }

    // 2. Search linked accounts
    if (!email) {
      const emailAccount = linkedAccounts.find(
        (acc: any) => acc.type === 'email',
      );
      const googleAccount = linkedAccounts.find(
        (acc: any) => acc.type === 'google_oauth',
      );
      const githubAccount = linkedAccounts.find(
        (acc: any) => acc.type === 'github_oauth',
      );
      const appleAccount = linkedAccounts.find(
        (acc: any) => acc.type === 'apple_oauth',
      );

      if (emailAccount) {
        email = emailAccount.address || emailAccount.email || null;
      } else if (googleAccount) {
        email = googleAccount.email || null;
        name = googleAccount.name || '';
      } else if (githubAccount) {
        email = githubAccount.email || null;
        name = githubAccount.name || '';
      } else if (appleAccount) {
        email = appleAccount.email || null;
      }
    }

    if (!email) {
      console.error(
        'Privy User missing email. Full object:',
        JSON.stringify(privyUser),
      );
      throw new BadRequestException('Email is required from social login');
    }

    // Fallback for name
    if (!name) {
      name = email.split('@')[0];
    }

    console.log('[privyLogin] Step 3: Email resolved:', email);

    // Check for existing user by email or wallet DID
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { wallet: true },
    });

    if (!user) {
      // If not found by email, try finding by wallet DID
      const wallet = await this.prisma.wallet.findFirst({
        where: { privyDid: privyDid },
        include: { user: true },
      });
      if (wallet && wallet.user) {
        user = wallet.user as any;
      }
    }

    if (!user) {
      // Validate role if provided
      const userRole =
        role && Object.values(UserRole).includes(role as UserRole)
          ? (role as UserRole)
          : UserRole.NONE;

      console.log('[privyLogin] Step 4: Creating new user...');
      // Sequential operations — Neon's PgBouncer pooler doesn't support interactive transactions
      const newUser = await this.prisma.user.create({
        data: {
          email,
          name,
          role: userRole,
          emailVerified: true,
        },
      });

      // Get the embedded wallet address from Privy
      const embeddedWallet = linkedAccounts.find(
        (account: any) =>
          account.type === 'wallet' && account.wallet_client_type === 'privy',
      );
      const walletAddress = embeddedWallet ? embeddedWallet.address : '';

      if (!walletAddress) {
        console.warn(
          `Privy User ${privyDid} has no wallet address during signup.`,
        );
      }

      // Check if a wallet with this DID already exists (orphaned)
      const orphanedWallet = await this.prisma.wallet.findUnique({
        where: { privyDid: privyDid },
      });

      if (orphanedWallet) {
        await this.prisma.wallet.update({
          where: { id: orphanedWallet.id },
          data: {
            userId: newUser.id,
            address: walletAddress || orphanedWallet.address,
            provider: 'PRIVY',
          },
        });
      } else {
        await this.prisma.wallet.create({
          data: {
            userId: newUser.id,
            address: walletAddress || `pending_${privyDid}`,
            privyDid: privyDid,
            provider: 'PRIVY',
          },
        });
      }

      user = await this.prisma.user.findUnique({
        where: { id: newUser.id },
        include: { wallet: true },
      });
    } else if (!user.wallet) {
      console.log(
        '[privyLogin] Step 4b: User exists but no wallet, linking...',
      );
      // Link existing user to Privy if not linked
      const existingWallet = await this.prisma.wallet.findFirst({
        where: { privyDid: privyDid },
      });

      if (!existingWallet) {
        const embeddedWallet = linkedAccounts.find(
          (account: any) =>
            account.type === 'wallet' && account.wallet_client_type === 'privy',
        );

        let walletAddress = embeddedWallet ? embeddedWallet.address : null;

        // If still no address but user is social/email, it's likely pending creation
        // Ensure 'pending' wallets are only created if no address is available
        if (!walletAddress) {
          walletAddress = `pending_${privyDid}`;
        }

        await this.prisma.wallet.create({
          data: {
            userId: user.id,
            address: walletAddress,
            privyDid: privyDid,
            provider: 'PRIVY',
          },
        });
      } else {
        console.warn(
          `Wallet with DID ${privyDid} exists but user ${user.id} has no wallet linked. Linking now if possible.`,
        );
      }

      // Refresh user object
      user = await this.prisma.user.findUnique({
        where: { id: user.id },
        include: { wallet: true },
      });
    } else if (user.wallet && user.wallet.address.startsWith('pending_')) {
      // If user has a pending wallet, check if Privy now has a real address
      console.log(
        `[privyLogin] User ${user.id} has pending wallet ${user.wallet.address}. Checking for real address...`,
      );
      const embeddedWallet = linkedAccounts.find(
        (account: any) =>
          account.type === 'wallet' && account.wallet_client_type === 'privy',
      );

      if (embeddedWallet && embeddedWallet.address) {
        const realAddress = embeddedWallet.address;
        console.log(
          `[privyLogin] Found real address: ${realAddress}. Updating...`,
        );
        await this.prisma.wallet.update({
          where: { id: user.wallet.id },
          data: { address: realAddress },
        });

        // Refresh user object
        user = await this.prisma.user.findUnique({
          where: { id: user.id },
          include: { wallet: true },
        });
      }
    }

    if (!user) {
      throw new UnauthorizedException('Failed to synchronize user account');
    }

    const payload = {
      sub: user.id,
      id: user.id,
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    console.log('[privyLogin] Step 5: Creating session for user:', user.id);
    const accessTokenJwt = await this.jwtService.signAsync(payload);
    const refreshTokenJwt = await this.jwtService.signAsync(payload, {
      expiresIn: '30d',
    });

    // Create Session
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.prisma.session.upsert({
      where: { accessToken: accessTokenJwt },
      update: {
        refreshToken: refreshTokenJwt,
        expiresAt,
      },
      create: {
        userId: user.id,
        accessToken: accessTokenJwt,
        refreshToken: refreshTokenJwt,
        expiresAt,
      },
    });

    console.log('[privyLogin] Step 6: Login complete.');
    return {
      user: this.sanitizeUser(user),
      accessToken: accessTokenJwt,
      refreshToken: refreshTokenJwt,
    };
  }

  async logout(userId: string, token?: string) {
    if (token) {
      await this.blacklistToken(token);
    }
    await this.prisma.session.deleteMany({
      where: { userId, accessToken: token },
    });
    return { success: true };
  }

  private async blacklistToken(token: string) {
    try {
      const decoded = this.jwtService.decode(token);
      if (decoded && decoded.exp) {
        const ttl = Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
        if (ttl > 0) {
          await this.redis.set(`blacklist:${token}`, '1', ttl);
        }
      }
    } catch (err) {
      // Ignore decode errors
    }
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'User not found',
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
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
    });
    if (session && session.userId === userId) {
      await this.blacklistToken(session.accessToken);
      await this.prisma.session.delete({
        where: { id: sessionId },
      });
    }
    return { success: true };
  }

  async revokeAllSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId },
    });
    for (const session of sessions) {
      await this.blacklistToken(session.accessToken);
    }
    const result = await this.prisma.session.deleteMany({
      where: { userId },
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
