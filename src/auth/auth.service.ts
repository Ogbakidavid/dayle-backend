import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { decodeJwt } from 'jose';
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

  async privyLogin(
    accessToken: string,
    role?: string,
    initialName?: string,
    initialCountry?: string,
  ): Promise<{ user: any; accessToken: string; refreshToken: string }> {
    let verifiedClaims: any;
    try {
      verifiedClaims = await this.privyService.verifyToken(accessToken);
    } catch (error) {
      console.error(
        '[privyLogin] Token verification failed:',
        error.message || error,
      );

      // Attempt to decode for debugging info (without verification)
      try {
        const decoded = decodeJwt(accessToken);
        console.log(
          `[privyLogin] Failed token metadata - aud: ${decoded.aud}, iss: ${decoded.iss}, sub: ${decoded.sub}`,
        );
      } catch (e) {
        console.warn('[privyLogin] Could not even decode token for debugging');
      }

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
    const privyUser = (await this.privyService.getUser(privyDid)) as any;
    const linkedAccounts: any[] = privyUser.linked_accounts || [];

    console.log(
      '[privyLogin] Step 2: Got Privy user. linked_accounts count:',
      linkedAccounts.length,
      '| Full user:',
      JSON.stringify(privyUser),
    );

    // Extract email — check all possible locations
    let email: string | null = null;
    let name = '';

    // Search linked accounts for email
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

    if (!email) {
      console.error(
        'Privy User missing email. Full object:',
        JSON.stringify(privyUser),
      );
      throw new BadRequestException('Email is required from social login');
    }

    // Fallback for name: Prioritize the name passed from the frontend (e.g. Signup form)
    // Then fall back to social media name (if any), then email prefix
    if (initialName) {
      name = initialName;
    } else if (!name) {
      name = email.split('@')[0];
    }

    // Prepare country
    let country: string | null = null;
    if (initialCountry) {
      const c = initialCountry.toUpperCase();
      country =
        c === 'NIGERIA' || c === 'NGA' || c === 'NG'
          ? 'NG'
          : c === 'KENYA' || c === 'KEN' || c === 'KE'
            ? 'KE'
            : c;
    }

    console.log('[privyLogin] Step 3: Email resolved:', email);

    // Check for existing user by email or wallet DID
    let user: any = await this.prisma.user.findUnique({
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
          country,
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

      const refreshedUser = await this.prisma.user.findUnique({
        where: { id: newUser.id },
        include: { wallet: true },
      });
      if (!refreshedUser) {
        throw new UnauthorizedException('Failed to fetch newly created user');
      }
      user = refreshedUser;
    } else {
      // Logic for existing user: Update name/country if missing
      const updates: any = {};
      const isDefaultName = user.name === user.email.split('@')[0];
      if (name && (!user.name || isDefaultName)) {
        updates.name = name;
      }
      if (country && !user.country) {
        updates.country = country;
      }

      if (Object.keys(updates).length > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: updates,
        });
        // Refresh
        user = await this.prisma.user.findUnique({
          where: { id: user.id },
          include: { wallet: true },
        });
      }

      // Check wallet synchronization
      if (!user.wallet) {
        console.log('[privyLogin] Step 4b: Existing user, no wallet, linking...');
        const existingWallet = await this.prisma.wallet.findFirst({
          where: { privyDid },
        });

        if (!existingWallet) {
          const embeddedWallet = linkedAccounts.find(
            (acc: any) => acc.type === 'wallet' && acc.wallet_client_type === 'privy',
          );
          const walletAddress = embeddedWallet?.address || `pending_${privyDid}`;

          await this.prisma.wallet.create({
            data: {
              userId: user.id,
              address: walletAddress,
              privyDid: privyDid,
              provider: 'PRIVY',
            },
          });
        }
        
        // Final refresh
        user = await this.prisma.user.findUnique({
          where: { id: user.id },
          include: { wallet: true },
        });
      } else if (user.wallet.address.startsWith('pending_')) {
        console.log(`[privyLogin] User ${user.id} has pending wallet. Checking for real address...`);
        const embeddedWallet = linkedAccounts.find(
          (acc: any) => acc.type === 'wallet' && acc.wallet_client_type === 'privy',
        );

        if (embeddedWallet?.address) {
          await this.prisma.wallet.update({
            where: { id: user.wallet.id },
            data: { address: embeddedWallet.address },
          });
          // Refresh
          user = await this.prisma.user.findUnique({
            where: { id: user.id },
            include: { wallet: true },
          });
        }
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
      expiresIn: '14d',
    });

    // Create Session
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 14);

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
      const decoded = this.jwtService.decode(token) as any;
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
    const data: any = {
      name: dto.name,
      profileImage: dto.profileImage,
    };

    if (dto.country) {
      const c = dto.country.toUpperCase();
      data.country =
        c === 'NIGERIA' || c === 'NGA'
          ? 'NG'
          : c === 'KENYA' || c === 'KEN'
            ? 'KE'
            : c;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
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
