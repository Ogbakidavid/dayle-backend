import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MilestoneStatus, VerificationResult } from '../domain/enums';
import { StateMachine } from '../domain/state-machine';

@Injectable()
export class VerificationService {
  constructor(private prisma: PrismaService) {}

  async verify(milestoneId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
    });

    if (!milestone) {
      throw new NotFoundException({
        code: 'MILESTONE_NOT_FOUND',
        message: 'Milestone not found',
      });
    }

    // Validate transition
    const canVerify = StateMachine.canVerifyMilestone(
      milestone.status as MilestoneStatus,
    );
    StateMachine.assertTransition(
      canVerify,
      `Cannot verify milestone from status ${milestone.status}. Must be SUBMITTED.`,
    );

    // Mock Verification Logic
    // In a real system, this would call an external AI service
    const verificationData = {
      verifiedAt: new Date(),
      result: VerificationResult.PASS,
      score: 95,
      notes: 'AI Verification successful (Mock)',
      metadata: {
        issuesDetected: [],
        completenessScore: 1.0,
      },
    };

    // Update milestone and create verification record
    const updatedMilestone = await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        status: MilestoneStatus.AWAITING_APPROVAL,
        verification: {
          create: {
            result: verificationData.result,
            verifiedAt: verificationData.verifiedAt,
            ruleResultsJson: verificationData.metadata,
          },
        },
      },
      include: {
        verification: true,
        submission: true,
        review: true,
      },
    });

    return updatedMilestone;
  }
}
