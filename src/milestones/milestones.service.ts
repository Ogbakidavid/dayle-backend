import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SubmitMilestoneDto } from "./dto/submit-milestone.dto";
import { ReviewMilestoneDto } from "./dto/review-milestone.dto";
import { MilestoneStatus } from "../domain/enums";
import { StateMachine } from "../domain/state-machine";
import { VerificationService } from "../verification/verification.service";

@Injectable()
export class MilestonesService {
  constructor(
    private prisma: PrismaService,
    private verificationService: VerificationService,
  ) {}

  async submit(id: string, dto: SubmitMilestoneDto, userId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!milestone) {
      throw new NotFoundException({
        code: "MILESTONE_NOT_FOUND",
        message: "Milestone not found",
      });
    }

    if (milestone.vault.freelancerId !== userId) {
      throw new ForbiddenException({
        code: "UNAUTHORIZED",
        message: "Only vault freelancer can submit milestones",
      });
    }

    // State machine validation
    const canSubmit = StateMachine.canSubmitMilestone(
      milestone.status as MilestoneStatus,
    );
    StateMachine.assertTransition(
      canSubmit,
      `Cannot submit milestone from status ${milestone.status}`,
    );

    // Create submission
    const updatedMilestone = await this.prisma.milestone.update({
      where: { id },
      data: {
        status: MilestoneStatus.SUBMITTED,
        submission: {
          create: {
            submittedBy: userId,
            notes: dto.notes,
            filesJson: (dto.filesJson as any) || [],
            url: dto.url,
            fileUrl: dto.fileUrl,
          },
        },
      },
      include: { submission: true },
    });

    // Trigger AI verification (async)
    if (milestone.auditEnabled !== false) {
      this.verificationService.verify(id).catch((err) => {
        console.error("Verification failed:", err);
      });
    }

    return updatedMilestone;
  }

  async review(id: string, dto: ReviewMilestoneDto, userId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id },
      include: { vault: true },
    });

    if (!milestone) {
      throw new NotFoundException({
        code: "MILESTONE_NOT_FOUND",
        message: "Milestone not found",
      });
    }

    if (milestone.vault.clientId !== userId) {
      throw new ForbiddenException({
        code: "UNAUTHORIZED",
        message: "Only vault client can review milestones",
      });
    }

    // State machine validation
    const canReview = StateMachine.canReviewMilestone(
      milestone.status as MilestoneStatus,
    );
    StateMachine.assertTransition(
      canReview,
      `Cannot review milestone from status ${milestone.status}`,
    );

    // Map outcome to status
    const newStatus = StateMachine.mapOutcomeToStatus(dto.outcome);

    // Update milestone
    const updatedMilestone = await this.prisma.milestone.update({
      where: { id },
      data: {
        status: newStatus,
        review: {
          create: {
            reviewerId: userId,
            outcome: dto.outcome,
            reasonCodes: dto.reasonCodes || [],
            notes: dto.notes,
          },
        },
      },
      include: { review: true, submission: true, verification: true },
    });

    return updatedMilestone;
  }
}