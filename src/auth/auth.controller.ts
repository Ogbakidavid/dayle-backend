import { Controller, Post, Get, Body, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { SignupDto } from "./dto/signup.dto";
import { LoginDto } from "./dto/login.dto";
import { Public } from "../common/decorators/public.decorator";
import { User } from "../common/decorators/user.decorator";

@Controller("auth")
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post("signup")
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Public()
  @Post("login")
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post("logout")
  async logout(@User("id") userId: string) {
    return this.authService.logout(userId);
  }

  @Get("me")
  async getCurrentUser(@User("id") userId: string) {
    return this.authService.getCurrentUser(userId);
  }
}