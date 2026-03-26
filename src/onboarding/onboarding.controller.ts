import { Controller, Post, Patch, Get, Body, Logger, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OnboardingService } from './onboarding.service';
import { SetRoleDto } from './dto/set-role.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { User } from '../common/decorators/user.decorator';

@Controller('onboarding')
export class OnboardingController {
  private readonly logger = new Logger(OnboardingController.name);
  constructor(private readonly onboardingService: OnboardingService) {}

  @Patch('role')
  async setRole(@User('id') userId: string, @Body() dto: SetRoleDto) {
    return this.onboardingService.setRole(userId, dto);
  }

  @Post('identity')
  async submitIdentity(@User('id') userId: string, @Body() dto: SubmitIdentityDto) {
    return this.onboardingService.submitIdentity(userId, dto);
  }

  @Post('initialize')
  async initialize(@User('id') userId: string) {
    return this.onboardingService.initializePartnaAccount(userId);
  }

  @Post('verify-identity')
  async verifyIdentity(@User('id') userId: string, @Body() dto: SubmitIdentityDto) {
    return this.onboardingService.verifyIdentity(userId, dto);
  }

  @Post('kyc')
  async submitKyc(@User('id') userId: string, @Body() dto: SubmitKycDto) {
    return this.onboardingService.submitKyc(userId, dto);
  }

  @Post('kyc-method')
  async selectKycMethod(@User('id') userId: string, @Body('method') method: string) {
    return this.onboardingService.selectKycMethod(userId, method);
  }

  @Post('kyc-otp')
  async verifyKycOtp(@User('id') userId: string, @Body('otp') otp: string) {
    return this.onboardingService.verifyKycOtp(userId, otp);
  }

  @Post('kyc-confirm-phone')
  async confirmKycPhone(@User('id') userId: string, @Body('phone') phone: string) {
    return this.onboardingService.confirmKycPhone(userId, phone);
  }

  @Get('status')
  async getStatus(@User('id') userId: string) {
    return this.onboardingService.getStatus(userId);
  }

  @Get('didit/session')
  async getDiditSession(@User('id') userId: string) {
    return this.onboardingService.getDiditSession(userId);
  }

  // DEV ONLY - Remove before production deployment
  @Post('dev-bypass-identity')
  async devBypassIdentity(@User('id') userId: string, @Req() req: Request) {
    this.logger.log('[DEV BYPASS] Request received, NODE_ENV: ' + process.env.NODE_ENV);
    this.logger.log('[DEV BYPASS] Auth header present: ' + !!req.headers.authorization);
    return this.onboardingService.devBypassIdentity(userId);
  }
}
