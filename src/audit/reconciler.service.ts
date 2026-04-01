import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import {
  VaultStatus,
  LedgerEntryType,
  TransactionStatus,
} from '../domain/enums';

@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  constructor(
    private prisma: PrismaService,
    private partna: PartnaService,
    private paycrest: PaycrestService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    try {
      this.logger.log('Starting proactive reconciliation...');
      await this.reconcileVaults();
    } catch (err) {
      if (err.message.includes('EAI_AGAIN') || err.message.includes('P1001')) {
        this.logger.warn('Reconciler Service: Database temporarily unreachable. Skipping this run.');
      } else {
        this.logger.error(`Reconciler Service Failed: ${err.message}`);
      }
    }
  }

  async reconcileVaults() {
    const activeVaults = await this.prisma.vault.findMany({
      where: {
        status: { in: [VaultStatus.FUNDED, VaultStatus.RELEASED] },
        isFrozen: false,
      } as any,
      include: { ledgerEntries: true },
    });

    for (const vault of activeVaults) {
      try {
        await this.checkVaultIntegrity(vault);
      } catch (error) {
        this.logger.error(
          `Failed to reconcile vault ${vault.id}: ${error.message}`,
        );
      }
    }
  }

  private async checkVaultIntegrity(vault: any) {
    // 1. Calculate Ledger Balance using BigInt throughout
    const ledgerBalance = vault.ledgerEntries
      .filter((e: any) => e.status === TransactionStatus.CONFIRMED)
      .reduce((acc: bigint, entry: any) => {
        const amount = BigInt(entry.amount);
        if (entry.type === LedgerEntryType.DEPOSIT) return acc + amount;
        if (
          entry.type === LedgerEntryType.RELEASE ||
          entry.type === LedgerEntryType.REFUND
        )
          return acc - amount;
        return acc;
      }, BigInt(0));

    // 2. Check Requirement: Ledger Balance should match Vault Total (roughly)
    const totalAmount = BigInt(vault.totalAmount);

    const deposits = vault.ledgerEntries.filter(
      (e: any) =>
        e.type === LedgerEntryType.DEPOSIT &&
        e.status === TransactionStatus.CONFIRMED,
    );
    const totalDeposited = deposits.reduce(
      (acc: bigint, e: any) => acc + BigInt(e.amount),
      BigInt(0),
    );

    if (totalDeposited < totalAmount) {
      await this.freezeVault(
        vault.id,
        `Funding Mismatch: Expected ${totalAmount}, found ${totalDeposited}`,
      );
      return;
    }

    // 3. Check for Anomalies (e.g. Negative Balance)
    if (ledgerBalance < BigInt(0)) {
      await this.freezeVault(
        vault.id,
        `Negative Balance Detected: ${ledgerBalance}`,
      );
      return;
    }

    this.logger.log(`Vault ${vault.id} verified. Balance: ${ledgerBalance}`);
  }

  private async freezeVault(vaultId: string, reason: string) {
    this.logger.warn(`FREEZING Vault ${vaultId}: ${reason}`);
    await this.prisma.vault.update({
      where: { id: vaultId },
      data: {
        isFrozen: true,
        frozenReason: reason,
      } as any,
    });
  }
}
