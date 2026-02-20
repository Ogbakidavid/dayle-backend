import { Controller, Post, Body, UnauthorizedException, Res, Get, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { Public } from '../../common/decorators/public.decorator';
import type { Response } from 'express';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private authService: AdminAuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) response: Response) {
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

  @Post('logout')
  async logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie("admin_access_token");
    return { success: true };
  }

  @Get('me')
  @UseGuards(AuthGuard('admin-jwt'))
  async getMe(@Req() req: any) {
    return req.user;
  }
}
