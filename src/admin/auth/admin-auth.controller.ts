import { Controller, Post, Body, UnauthorizedException, Res } from '@nestjs/common';
import { AdminAuthService } from './admin-auth.service';
import { LoginDto } from '../../auth/dto/login.dto';
import type { Response } from 'express';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private authService: AdminAuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
     const admin = await this.authService.validateAdmin(dto.email, dto.password);
     if (!admin) {
         throw new UnauthorizedException('Invalid admin credentials');
     }
     const { access_token } = await this.authService.login(admin);
     
     // Set cookie for admin
     response.cookie("admin_access_token", access_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 24 * 60 * 60 * 1000, // 1 day
     });

     return { access_token, admin };
  }
}
