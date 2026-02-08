import { Controller, Post, Patch, Get, Body } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { SetRoleDto } from "./dto/set-role.dto";
import { SubmitKycDto } from "./dto/submit-kyc.dto";
import { User } from "../common/decorators/user.decorator";

@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Patch("role")
  async setRole(@User("id") userId: string, @Body() dto: SetRoleDto) {
    return this.onboardingService.setRole(userId, dto);
  }

  @Post("kyc")
  async submitKyc(@User("id") userId: string, @Body() dto: SubmitKycDto) {
    return this.onboardingService.submitKyc(userId, dto);
  }

  @Get("status")
  async getStatus(@User("id") userId: string) {
    return this.onboardingService.getStatus(userId);
  }
}
