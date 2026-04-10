import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { MailsService } from './mails.service';
import { Injectable, Logger } from '@nestjs/common';

@Processor('mail', {
  concurrency: 1,
  stalledInterval: 300000,
  lockDuration: 300000,
  drainDelay: 60000,
})
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private mailsService: MailsService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of type ${job.name}`);

    if (job.name === 'sendInvite') {
      const { to, clientName, vaultTitle, amount, inviteToken, localCurrency, localAmount } = job.data;
      return this.mailsService.handleSendInviteEmail(
        to,
        clientName,
        vaultTitle,
        amount,
        inviteToken,
        localCurrency,
        localAmount,
      );
    }

    if (job.name === 'sendVaultFunded') {
      const { to, userName, vaultTitle, amount, isFreelancer, localCurrency, localAmount } = job.data;
      return this.mailsService.handleSendVaultFundedEmail(
        to,
        userName,
        vaultTitle,
        amount,
        isFreelancer,
        localCurrency,
        localAmount,
      );
    }

    if (job.name === 'sendVaultStatus') {
      const { to, userName, vaultTitle, eventType, actionLink, otherPartyName, notes } = job.data;
      return this.mailsService.handleSendVaultStatusEmail(
        to,
        userName,
        vaultTitle,
        eventType,
        actionLink,
        otherPartyName,
        notes,
      );
    }

    if (job.name === 'sendDisputeOffer') {
      const { to, userName, vaultTitle, offerType, actionLink, otherPartyName, amountToFreelancer, notes } = job.data;
      return this.mailsService.handleSendDisputeOfferEmail(
        to,
        userName,
        vaultTitle,
        offerType,
        actionLink,
        otherPartyName,
        amountToFreelancer,
        notes,
      );
    }
  }
}
