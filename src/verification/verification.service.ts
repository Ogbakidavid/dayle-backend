import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MilestoneStatus, VerificationResult } from '../domain/enums';
import { StateMachine } from '../domain/state-machine';
import { DeliverableType, RuleResult } from '../domain/deliverables';

@Injectable()
export class VerificationService {
  constructor(private prisma: PrismaService) {}

  async verify(milestoneId: string) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { submission: true, vault: true },
    });

    if (!milestone) {
      throw new NotFoundException({
        code: 'MILESTONE_NOT_FOUND',
        message: 'Milestone not found',
      });
    }

    if (!milestone.submission) {
      return; // Nothing to verify yet
    }

    // Validate transition
    const canVerify = StateMachine.canVerifyMilestone(
      milestone.status as MilestoneStatus,
    );
    StateMachine.assertTransition(
      canVerify,
      `Cannot verify milestone from status ${milestone.status}. Must be SUBMITTED.`,
    );

    // Evaluate Specialized Rules
    const { results, overallPass } = this.evaluateRules(milestone);

    // Final result mapping
    const result = overallPass ? VerificationResult.PASS : VerificationResult.FAIL;

    // Update milestone and create verification record
    const updatedMilestone = await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        status: overallPass ? MilestoneStatus.AWAITING_APPROVAL : MilestoneStatus.REVISION_REQUESTED,
        verification: {
          upsert: {
            create: {
              result,
              verifiedAt: new Date(),
              notes: overallPass ? 'All automated rules passed.' : 'One or more rules failed.',
              ruleResultsJson: results as any,
              confidence: 1.0,
            },
            update: {
              result,
              verifiedAt: new Date(),
              notes: overallPass ? 'All automated rules passed.' : 'One or more rules failed.',
              ruleResultsJson: results as any,
              confidence: 1.0,
            },
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

  private evaluateRules(milestone: any): { results: RuleResult[]; overallPass: boolean } {
    const requirements = (milestone.requirementItemsJson as any[]) || [];
    const submission = milestone.submission;
    const results: RuleResult[] = [];
    let overallPass = true;

    for (const req of requirements) {
      let passed = true;
      let message = '';

      switch (milestone.deliverableTypeId) {
        case DeliverableType.GITHUB:
          ({ passed, message } = this.evaluateGitHubRule(req, submission));
          break;
        case DeliverableType.FIGMA:
          ({ passed, message } = this.evaluateFigmaRule(req, submission));
          break;
        case DeliverableType.PDF:
          ({ passed, message } = this.evaluatePdfRule(req, submission));
          break;
        default:
          // Generic validation if no specific type
          if (req.required && !submission.url && !submission.fileUrl) {
            passed = false;
            message = 'Required submission missing';
          }
      }

      results.push({
        ruleId: req.reqId,
        label: req.label,
        passed,
        message,
      });

      if (req.required && !passed) {
        overallPass = false;
      }
    }

    return { results, overallPass };
  }

  private evaluateGitHubRule(rule: any, submission: any): { passed: boolean; message: string } {
    const url = submission.url || '';
    
    if (rule.type === 'github_repo') {
      const isGitHub = url.toLowerCase().includes('github.com');
      if (!isGitHub) {
        return { passed: false, message: 'URL must be a valid GitHub repository' };
      }
      
      // Basic pattern check if specified
      if (rule.repoUrlPattern && !new RegExp(rule.repoUrlPattern).test(url)) {
        return { passed: false, message: `URL does not match required pattern: ${rule.repoUrlPattern}` };
      }
    }

    return { passed: true, message: 'Source control link validated' };
  }

  private evaluateFigmaRule(rule: any, submission: any): { passed: boolean; message: string } {
    const url = submission.url || '';

    if (rule.type === 'figma_link') {
      const isFigma = url.toLowerCase().includes('figma.com/file/');
      if (!isFigma) {
        return { passed: false, message: 'URL must be a valid Figma file link' };
      }
    }

    return { passed: true, message: 'Figma link validated' };
  }

  private evaluatePdfRule(rule: any, submission: any): { passed: boolean; message: string } {
    const fileUrl = submission.fileUrl || '';
    
    if (rule.type === 'pdf_file') {
      const isPdf = fileUrl.toLowerCase().endsWith('.pdf');
      if (!isPdf) {
        return { passed: false, message: 'Submitted file must be a PDF' };
      }
    }

    return { passed: true, message: 'PDF submission validated' };
  }
}
