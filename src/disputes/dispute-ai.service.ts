import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { ethers } from 'ethers';

@Injectable()
export class DisputeAiService {
  private readonly logger = new Logger(DisputeAiService.name);
  private genAI: GoogleGenerativeAI;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('GOOGLE_AI_API_KEY');
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
  }

  async analyzeDispute(disputeId: string) {
    if (!this.genAI) {
      const apiKey = this.configService.get<string>('GOOGLE_AI_API_KEY');
      if (apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
      } else {
        throw new Error('GOOGLE_AI_API_KEY is not configured. Please add it to your .env file.');
      }
    }

    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        vault: {
          include: {
            deliverables: true
          }
        },
        events: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    const evidence = await (this.prisma as any).evidence.findMany({
      where: { vaultId: dispute.vaultId },
    });

    const decimals = (dispute.vault as any).tokenDecimals || 18;
    const humanTotalAmount = ethers.formatUnits(dispute.vault.totalAmount, decimals);

    // Use a stable production model
    const model = this.genAI.getGenerativeModel({ 
      model: 'gemini-2.5-pro',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            rationale: { type: SchemaType.STRING },
            recommendedOutcome: { 
              type: SchemaType.STRING, 
              enum: ['RELEASE', 'REFUND', 'SPLIT'],
              nullable: false, 
            } as any,
            recommendedSplitAmount: { 
              type: SchemaType.NUMBER,
              description: `The amount to release to the freelancer if outcome is SPLIT. Return this as a human-readable decimal (e.g., 450.50) NOT base units. Max allowed: ${humanTotalAmount}`
            }
          },
          required: ['rationale', 'recommendedOutcome']
        }
      }
    });

    const prompt = `
      You are an impartial arbitrator for Dayle, a decentralized escrow platform. 
      Your goal is to analyze the evidence and events in a dispute and provide a fair resolution.

      DISPUTE CONTEXT:
      - Dispute ID: ${dispute.id}
      - Vault Title: ${dispute.vault.title}
      - Vault Description: ${(dispute.vault as any).description || 'No description provided'}
      - Dispute Description: ${dispute.description}
      - Reason Code: ${dispute.reasonCode}
      - Claimant Role: ${dispute.openedByRole}
      - Total Vault Amount: ${humanTotalAmount} (Human-readable units)
      
      CONTRACTUAL DELIVERABLES:
      ${(dispute.vault as any).deliverables?.map((d: any) => `- TITLE: ${d.title} | DESCRIPTION: ${d.description || 'N/A'}`).join('\n') || 'No specific deliverables listed'}

      EVIDENCE LOG (Submissions from both parties):
      ${evidence.map((e: any) => `- [${e.createdAt}] TYPE: ${e.type} | CONTENT: ${typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)}`).join('\n') || 'No evidence uploaded yet'}

      PROTOCOL EVENTS (System-logged actions):
      ${dispute.events.map((ev: any) => `- [${ev.createdAt}] EVENT: ${ev.eventType} | DATA: ${JSON.stringify(ev.payload)}`).join('\n')}

      RESOLUTION CRITERIA:
      - RELEASE: Work was substantially completed according to the deliverables.
      - REFUND: Work was not completed or significantly deviated from the agreement.
      - SPLIT: Partial work was completed, or both parties bear some responsibility. If SPLIT, specify the exact amount for the freelancer.

      Note: The total vault amount is ${humanTotalAmount}.
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      const analysis = JSON.parse(text);

      // Backend safety check: ensure split amount doesn't exceed total
      if (analysis.recommendedOutcome === 'SPLIT' && analysis.recommendedSplitAmount > Number(humanTotalAmount)) {
        analysis.recommendedSplitAmount = Number(humanTotalAmount);
      }

      return analysis;
    } catch (error) {
      this.logger.error(`AI Analysis failed: ${error.message}`);
      throw new Error(`Failed to analyze dispute with AI: ${error.message}`);
    }
  }
}
