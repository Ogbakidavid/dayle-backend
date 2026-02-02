import { BadRequestException } from "@nestjs/common";
import {
  MilestoneStatus,
  MilestoneReviewOutcome,
  VerificationResult,
} from "./enums";

export class StateMachine {
  /**
   * Validate milestone submit transition
   */
  static canSubmitMilestone(currentStatus: MilestoneStatus): boolean {
    const allowedStatuses = [
      MilestoneStatus.PENDING,
      MilestoneStatus.REVISION_REQUESTED,
      MilestoneStatus.REJECTED,
    ];
    return allowedStatuses.includes(currentStatus);
  }

  /**
   * Validate milestone verify transition
   */
  static canVerifyMilestone(currentStatus: MilestoneStatus): boolean {
    return currentStatus === MilestoneStatus.SUBMITTED;
  }

  /**
   * Validate milestone review transition
   */
  static canReviewMilestone(currentStatus: MilestoneStatus): boolean {
    return currentStatus === MilestoneStatus.AWAITING_APPROVAL;
  }

  /**
   * Validate milestone release transition
   * CRITICAL: This enforces the release safety conditions
   */
  static canReleaseMilestone(
    currentStatus: MilestoneStatus,
    auditEnabled: boolean,
    verification: { result: VerificationResult } | null,
  ): { allowed: boolean; reason?: string } {
    // Must be in AWAITING_APPROVAL
    if (currentStatus !== MilestoneStatus.AWAITING_APPROVAL) {
      return {
        allowed: false,
        reason: `Milestone must be in AWAITING_APPROVAL status, currently ${currentStatus}`,
      };
    }

    // If audit enabled, verification must exist and not be FAIL
    if (auditEnabled !== false) {
      if (!verification) {
        return {
          allowed: false,
          reason: "Verification required when audit is enabled",
        };
      }

      if (verification.result === VerificationResult.FAIL) {
        return {
          allowed: false,
          reason: "Cannot release milestone with FAIL verification result",
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Map review outcome to milestone status
   */
  static mapOutcomeToStatus(outcome: MilestoneReviewOutcome): MilestoneStatus {
    const mapping = {
      [MilestoneReviewOutcome.APPROVE]: MilestoneStatus.VERIFIED,
      [MilestoneReviewOutcome.REQUEST_CHANGES]:
        MilestoneStatus.REVISION_REQUESTED,
      [MilestoneReviewOutcome.REJECT]: MilestoneStatus.REJECTED,
    };

    return mapping[outcome];
  }

  /**
   * Throw error if transition not allowed
   */
  static assertTransition(allowed: boolean, message: string): void {
    if (!allowed) {
      throw new BadRequestException({
        code: "INVALID_STATE_TRANSITION",
        message,
      });
    }
  }
}