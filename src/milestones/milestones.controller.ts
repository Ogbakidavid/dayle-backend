import { Controller, Post, Param, Body, Get } from "@nestjs/common";
import { MilestonesService } from "./milestones.service";
import { SubmitMilestoneDto } from "./dto/submit-milestone.dto";
import { ReviewMilestoneDto } from "./dto/review-milestone.dto";
import { Roles } from "../common/decorators/roles.decorator";
import { User } from "../common/decorators/user.decorator";
import { UserRole } from "../domain/enums";

@Controller("milestones")
export class MilestonesController {
  constructor(private milestonesService: MilestonesService) {}

  @Post(":id/submit")
  @Roles(UserRole.FREELANCER)
  async submit(
    @Param("id") id: string,
    @Body() dto: SubmitMilestoneDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.milestonesService.submit(id, dto, userId, role);
  }

  @Post(":id/verify")
  async verify(@Param("id") id: string) {
    return this.milestonesService.verify(id);
  }

  @Post(":id/review")
  @Roles(UserRole.CLIENT)
  async review(
    @Param("id") id: string,
    @Body() dto: ReviewMilestoneDto,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.milestonesService.review(id, dto, userId, role);
  }

  @Get(":id/evidence")
  async getEvidence(
    @Param("id") milestoneId: string,
    @User("id") userId: string,
    @User("role") role: UserRole,
  ) {
    return this.milestonesService.getEvidence(milestoneId, userId, role);
  }
}