import { Controller, Post, Get, Body, Patch, Res, Param, Delete, Query } from "@nestjs/common";
import type { Response } from "express";
import { AuthService } from "./auth.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { Public } from "../common/decorators/public.decorator";
import { User } from "../common/decorators/user.decorator";

@Controller("auth")
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post("logout")
  async logout(
    @User("id") userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.logout(userId);
    response.clearCookie("access_token");
    response.clearCookie("refresh_token");
    return { success: true };
  }

  private setTokensInCookies(
    response: Response,
    accessToken: string,
    refreshToken: string,
  ) {
    response.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });

    response.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }

  @Get("me")
  async getCurrentUser(@User("id") userId: string) {
    return this.authService.getCurrentUser(userId);
  }

  @Patch("profile")
  async updateProfile(
    @User("id") userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(userId, dto);
  }

  @Public()
  @Post("privy-login")
  async privyLogin(
    @Body() dto: { accessToken: string; role?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.privyLogin(
      dto.accessToken,
      dto.role,
    );
    this.setTokensInCookies(response, accessToken, refreshToken);
    return { user, accessToken };
  }

  // Session Management
  @Get("sessions")
  async getSessions(@User("id") userId: string) {
    return this.authService.getSessions(userId);
  }

  @Delete("sessions/:id")
  async revokeSession(
    @User("id") userId: string,
    @Param("id") sessionId: string,
  ) {
    return this.authService.revokeSession(userId, sessionId);
  }

  @Delete("sessions")
  async revokeAllSessions(@User("id") userId: string) {
    return this.authService.revokeAllSessions(userId);
  }

  // 2FA Management
  @Get("2fa/status")
  async get2FAStatus(@User("id") userId: string) {
    return this.authService.get2FAStatus(userId);
  }
}