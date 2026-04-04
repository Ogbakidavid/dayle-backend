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

  async sendVaultFundedEmail(
    to: string,
    userName: string,
    vaultTitle: string,
    amount: string,
    isFreelancer: boolean,
  ) {
    if (!this.mailQueue) {
      this.logger.warn(
        'Mail queue is not available. Skipping vault funded email queuing.',
      );
      return;
    }

    this.logger.log(`Queueing vault funded email to ${to}...`);
    await this.mailQueue.add(
      'sendVaultFunded',
      {
        to,
        userName,
        vaultTitle,
        amount,
        isFreelancer,
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
      this.logger.log(`Executing invite email sending to ${to}...`);
      
      const fromName = this.configService.get<string>('RESEND_FROM_NAME') || 'Dayle';
      const fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || 'notifications@orynexlabs.com';

      const { data, error } = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
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
        throw new Error(error.message || 'Failed to send email via Resend');
      } else {
        this.logger.log('Invite email sent successfully:', data?.id);
        return data;
      }
    } catch (err) {
      this.logger.error('Failed to send invite email:', err);
      throw err;
    }
  }

  async handleSendVaultFundedEmail(
    to: string,
    userName: string,
    vaultTitle: string,
    amount: string,
    isFreelancer: boolean,
  ) {
    if (!this.resend) {
      this.logger.log(
        `[MOCK EMAIL] To: ${to} | Subject: Vault Funded: ${vaultTitle}`,
      );
      this.logger.log(
        `[MOCK EMAIL] Content: Hello ${userName}, the vault "${vaultTitle}" has been funded with $${amount}. ${isFreelancer ? 'You can now start work.' : 'Your funds are secured.'}`,
      );
      return;
    }

    try {
      this.logger.log(`Executing vault funded email sending to ${to}...`);
      
      const fromName = this.configService.get<string>('RESEND_FROM_NAME') || 'Dayle';
      const fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || 'notifications@orynexlabs.com';

      const subject = isFreelancer 
        ? `Dayle: Funds Secured for "${vaultTitle}" — Start Work Now`
        : `Dayle: Your Vault "${vaultTitle}" is Successfully Funded`;

      const titleText = isFreelancer ? "Good news! Funds are secured." : "Payment Received!";
      const bodyText = isFreelancer
        ? `The funds for your project <strong>"${vaultTitle}"</strong> have been successfully locked in a secure Dayle vault. You can now safely begin working on the deliverables.`
        : `Your payment has been received and the vault <strong>"${vaultTitle}"</strong> is now active. Your funds ($${amount}) are securely held and will only be released when you approve the deliverables.`;

      const actionLink = `${this.configService.get('FRONTEND_URL') || 'http://localhost:3000'}/${isFreelancer ? 'freelancer' : 'client'}/vaults`;

      const { data, error } = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        subject: subject,
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h2 style="color: #10b981;">${titleText}</h2>
            </div>
            <p>Hello ${userName},</p>
            <p>${bodyText}</p>
            <div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Project:</strong> ${vaultTitle}</p>
              <p style="margin: 5px 0 0 0;"><strong>Amount:</strong> $${amount} USD</p>
            </div>
            <div style="text-align: center; margin-top: 30px;">
              <a href="${actionLink}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">View Vault</a>
            </div>
            <hr style="margin: 30px 0; border: 0; border-top: 1px solid #eee;" />
            <p style="font-size: 12px; color: #666; text-align: center;">
              This is an automated notification from Dayle. If you have any questions, please contact our support team.
            </p>
          </div>
        `,
      });

      if (error) {
        this.logger.error('Resend error:', error);
        throw new Error(error.message || 'Failed to send vault funded email via Resend');
      } else {
        this.logger.log('Vault funded email sent successfully:', data?.id);
        return data;
      }
    } catch (err) {
      this.logger.error('Failed to send vault funded email:', err);
      throw err;
    }
  }
}
