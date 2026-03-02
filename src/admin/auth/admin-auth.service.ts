import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminAuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async validateAdmin(email: string, pass: string): Promise<any> {
    const admin = await this.prisma.admin.findUnique({
      where: { email },
    });

    if (admin && (await bcrypt.compare(pass, admin.passwordHash))) {
      const { passwordHash, ...result } = admin;
      return result;
    }
    return null;
  }

  async login(admin: any) {
    const payload = {
      sub: admin.id,
      email: admin.email,
      role: 'ADMIN',
      permissions: admin.permissions,
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
