import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Resend } from 'resend';

@Injectable()
export class MailsService {
  private resend: Resend;
  private readonly logger = new Logger(MailsService.name);

  constructor(
    private configService: ConfigService,
    @Optional() @InjectQueue('mail') private mailQueue: Queue,
  ) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (apiKey) {
      this.resend = new Resend(apiKey);
    } else {
      this.logger.warn(
        'RESEND_API_KEY not found. MailsService will run in MOCK mode.',
      );
    }
  }

  async sendInviteEmail(
    to: string,
    clientName: string,
    vaultTitle: string,
    amount: number,
    inviteToken: string,
  ) {
    if (!this.mailQueue) {
      this.logger.warn(
        'Mail queue is not available. Skipping invite email queuing.',
      );
      return;
    }

    this.logger.log(`Queueing invite email to ${to}...`);
    await this.mailQueue.add(
      'sendInvite',
      {
        to,
        clientName,
        vaultTitle,
        amount,
        inviteToken,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
      },
    );
  }

  /**
   * Internal method called by the MailProcessor to execute the actual sending.
   */
  async handleSendInviteEmail(
    to: string,
    clientName: string,
    vaultTitle: string,
    amount: number,
    inviteToken: string,
  ) {
    const inviteLink = `${this.configService.get('FRONTEND_URL') || 'http://localhost:3000'}/invite/${inviteToken}`;

    if (!this.resend) {
      this.logger.log(
        `[MOCK EMAIL] To: ${to} | Subject: Invitation to join vault "${vaultTitle}"`,
      );
      this.logger.log(
        `[MOCK EMAIL] Content: ${clientName} invited you to a vault for $${amount}. Link: ${inviteLink}`,
      );
      return;
    }

    try {
      this.logger.log(`Executing email sending to ${to}...`);
      const fromEmail =
        this.configService.get<string>('RESEND_FROM_EMAIL') ||
        'onboarding@resend.dev';
      const { data, error } = await this.resend.emails.send({
        from: `Dayle <${fromEmail}>`,
        to: [to],
        subject: `Dayle: You've been invited to join vault "${vaultTitle}"`,
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>You've been invited!</h2>
            <p><strong>${clientName}</strong> has created a new secure project vault for you on Dayle.</p>
            <p><strong>Project:</strong> ${vaultTitle}</p>
            <p><strong>Amount:</strong> $${amount} USD</p>
            <hr />
            <p>Click the link below to accept the invitation and start working:</p>
            <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #000; color: #fff; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
            <p style="margin-top: 20px; font-size: 12px; color: #666;">If the button doesn't work, copy and paste this link: ${inviteLink}</p>
          </div>
        `,
      });

      if (error) {
        this.logger.error('Resend error:', error);
        throw new Error(JSON.stringify(error));
      } else {
        this.logger.log('Email sent successfully:', data?.id);
        return data;
      }
    } catch (err) {
      this.logger.error('Failed to send email:', err);
      throw err; // Re-throw to allow BullMQ to retry the job
    }
  }
}
