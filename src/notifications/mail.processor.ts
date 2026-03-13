import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MailsService } from './mails.service';
import { Injectable, Logger } from '@nestjs/common';

@Processor('mail')
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private mailsService: MailsService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);

    if (job.name === 'sendInvite') {
      const { to, clientName, vaultTitle, amount, inviteToken } = job.data;
      return this.mailsService.handleSendInviteEmail(
        to,
        clientName,
        vaultTitle,
        amount,
        inviteToken,
      );
    }
  }
}
