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
    localCurrency?: string,
    localAmount?: number,
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
        localCurrency,
        localAmount,
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
    localCurrency?: string,
    localAmount?: number,
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
        localCurrency,
        localAmount,
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

  async sendVaultStatusEmail(
    to: string,
    userName: string,
    vaultTitle: string,
    eventType: 'work_submitted' | 'release_requested' | 'changes_requested' | 'dispute_raised' | 'vault_released',
    actionLink: string,
    otherPartyName?: string,
  ) {
    if (!this.mailQueue) {
      this.logger.warn(
        'Mail queue is not available. Skipping vault status email queuing.',
      );
      return;
    }

    this.logger.log(`Queueing vault status email (${eventType}) to ${to}...`);
    await this.mailQueue.add(
      'sendVaultStatus',
      {
        to,
        userName,
        vaultTitle,
        eventType,
        actionLink,
        otherPartyName,
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
    localCurrency?: string,
    localAmount?: number,
  ) {
    const inviteLink = `${this.configService.get('FRONTEND_URL') || 'http://localhost:3000'}/invite/${inviteToken}`;

    const displayAmount = (localCurrency && localAmount && localCurrency !== 'USD')
      ? `${localAmount.toLocaleString()} ${localCurrency} ($${amount})`
      : `$${amount} USD`;


    if (!this.resend) {
      this.logger.log(
        `[MOCK EMAIL] To: ${to} | Subject: Invitation to join vault "${vaultTitle}"`,
      );
      this.logger.log(
        `[MOCK EMAIL] Content: ${clientName} invited you to a vault for ${displayAmount}. Link: ${inviteLink}`,
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
            <p><strong>Amount:</strong> ${displayAmount}</p>
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
    localCurrency?: string,
    localAmount?: number,
  ) {
    const displayAmount = (localCurrency && localAmount && localCurrency !== 'USD')
      ? `${localAmount.toLocaleString()} ${localCurrency} ($${amount})`
      : `$${amount} USD`;

    if (!this.resend) {
      this.logger.log(
        `[MOCK EMAIL] To: ${to} | Subject: Vault Funded: ${vaultTitle}`,
      );
      this.logger.log(
        `[MOCK EMAIL] Content: Hello ${userName}, the vault "${vaultTitle}" has been funded with ${displayAmount}. ${isFreelancer ? 'You can now start work.' : 'Your funds are secured.'}`,
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
        : `Your payment has been received and the vault <strong>"${vaultTitle}"</strong> is now active. Your funds (${displayAmount}) are securely held and will only be released when you approve the deliverables.`;

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
              <p style="margin: 5px 0 0 0;"><strong>Amount:</strong> ${displayAmount}</p>
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

  async handleSendVaultStatusEmail(
    to: string,
    userName: string,
    vaultTitle: string,
    eventType: 'work_submitted' | 'release_requested' | 'changes_requested' | 'dispute_raised' | 'vault_released',
    actionLink: string,
    otherPartyName?: string,
  ) {
    const eventConfig = {
      work_submitted: {
        subject: `Dayle: New work submitted for "${vaultTitle}"`,
        title: 'Work Submitted',
        body: `<strong>${otherPartyName || 'The freelancer'}</strong> has submitted work for your project. Please review the deliverables.`,
        color: '#10b981',
      },
      release_requested: {
        subject: `Dayle: Payment release requested for "${vaultTitle}"`,
        title: 'Release Requested',
        body: `<strong>${otherPartyName || 'The freelancer'}</strong> has requested that you release the funds for the project.`,
        color: '#3b82f6',
      },
      changes_requested: {
        subject: `Dayle: Changes requested for "${vaultTitle}"`,
        title: 'Changes Requested',
        body: `<strong>${otherPartyName || 'The client'}</strong> has requested some changes to your submission. Please check the vault for comments.`,
        color: '#f59e0b',
      },
      dispute_raised: {
        subject: `Dayle: A dispute has been raised for "${vaultTitle}"`,
        title: 'Dispute Raised',
        body: `A formal dispute has been initiated for the project <strong>"${vaultTitle}"</strong>. Both parties are encouraged to reach a mutual resolution in the next 48 hours.`,
        color: '#ef4444',
      },
      vault_released: {
        subject: `Dayle: Funds released for "${vaultTitle}" — Check your balance`,
        title: 'Payment Released!',
        body: `Great news! <strong>${otherPartyName || 'The client'}</strong> has approved your work and released the funds for <strong>"${vaultTitle}"</strong>. You can now withdraw your earnings.`,
        color: '#10b981',
      },
    };

    const config = eventConfig[eventType];
    const fullActionLink = `${this.configService.get('FRONTEND_URL') || 'http://localhost:3000'}${actionLink}`;

    if (!this.resend) {
      this.logger.log(`[MOCK EMAIL] To: ${to} | Subject: ${config.subject}`);
      this.logger.log(`[MOCK EMAIL] Content: Hello ${userName}, ${config.body} Link: ${fullActionLink}`);
      return;
    }

    try {
      const fromName = this.configService.get<string>('RESEND_FROM_NAME') || 'Dayle';
      const fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') || 'notifications@orynexlabs.com';

      const { data, error } = await this.resend.emails.send({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        subject: config.subject,
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h2 style="color: ${config.color};">${config.title}</h2>
            </div>
            <p>Hello ${userName},</p>
            <p>${config.body}</p>
            <div style="background-color: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 0;"><strong>Project:</strong> ${vaultTitle}</p>
            </div>
            <div style="text-align: center; margin-top: 30px;">
              <a href="${fullActionLink}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">View Details</a>
            </div>
            <hr style="margin: 30px 0; border: 0; border-top: 1px solid #eee;" />
            <p style="font-size: 12px; color: #666; text-align: center;">
              This is an automated notification from Dayle.
            </p>
          </div>
        `,
      });

      if (error) throw new Error(error.message);
      return data;
    } catch (err) {
      this.logger.error(`Failed to send status email (${eventType}):`, err);
      throw err;
    }
  }
}
