import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

import { SubmitMilestoneDto } from "./dto/submit-milestone.dto";
import { ReviewMilestoneDto } from "./dto/review-milestone.dto";
import { MilestoneStatus, UserRole } from "../domain/enums";
import { StateMachine } from "../domain/state-machine";
import { VerificationService } from "../verification/verification.service";
import { EvidenceService } from "../evidence/evidence.service";

@Injectable()
export class MilestonesService {
  constructor(
    private prisma: PrismaService,
    private verificationService: VerificationService,
    private evidenceService: EvidenceService,
  ) {}

  async submit(id: string, dto: SubmitMilestoneDto, userId: string, role: string) {
    const prisma = this.prisma;
    const milestone = await prisma.milestone.findUnique({
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

    const vault = milestone.vault as any;
    if (vault.isFrozen) {
      throw new ForbiddenException(`Vault is FROZEN: ${vault.frozenReason}`);
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
    const updatedMilestone = await prisma.milestone.update({
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

  async review(id: string, dto: ReviewMilestoneDto, userId: string, role: string) {
    const prisma = this.prisma;
    const milestone = await prisma.milestone.findUnique({
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
    const updatedMilestone = await prisma.milestone.update({
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

  async verify(id: string) {
    return this.verificationService.verify(id);
  }

  async getEvidence(milestoneId: string, userId: string, role: UserRole) {
    const prisma = this.prisma;
    // Check if milestone exists
    const milestone = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { vault: true },
    });

    if (!milestone) throw new NotFoundException("Milestone not found");

    // Pass through to evidence service for access check and listing
    return this.evidenceService.list(userId, role, milestone.vaultId, milestoneId);
  }
}