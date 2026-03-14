import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
        vault: true,
        events: true,
      },
    });

    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    const evidence = await (this.prisma as any).evidence.findMany({
      where: { vaultId: dispute.vaultId },
    });

    const model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

    const prompt = `
      You are an impartial arbitrator for Dayle, a decentralized escrow platform.
      Analyze the following dispute and provide a summary and a recommendation.

      DISPUTE CONTEXT:
      - Dispute ID: ${dispute.id}
      - Vault Title: ${dispute.vault.title}
      - Dispute Description: ${dispute.description}
      - Reason Code: ${dispute.reasonCode}
      - Claimant Role: ${dispute.openedByRole}
      - Total Vault Amount: ${dispute.vault.totalAmount}
      
      EVIDENCE LOG:
      ${evidence.map((e: any) => `- [${e.createdAt}] TYPE: ${e.type} | CONTENT: ${typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)}`).join('\n')}

      PROTOCOL EVENTS:
      ${dispute.events.map((ev: any) => `- [${ev.createdAt}] EVENT: ${ev.eventType} | DATA: ${JSON.stringify(ev.payload)}`).join('\n')}

      Based on the information provided, what should be the resolution?
      Allowed outcomes: RELEASE (pay freelancer), REFUND (return to client), SPLIT (specified amount to freelancer, rest to client).

      Return your response in PURE JSON format (no markdown blocks):
      {
        "rationale": "Full explanation of your analysis and findings...",
        "recommendedOutcome": "RELEASE" | "REFUND" | "SPLIT",
        "recommendedSplitAmount": number (only if outcome is SPLIT, how much goes to the freelancer)
      }
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Extract JSON from potential markdown code block
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return JSON.parse(text);
    } catch (error) {
      this.logger.error(`AI Analysis failed: ${error.message}`);
      throw new Error(`Failed to analyze dispute with AI: ${error.message}`);
    }
  }
}
