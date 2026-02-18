import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PartnaService } from '../common/services/partna.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { VaultStatus, LedgerEntryType, TransactionStatus } from '../domain/enums';

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
    this.logger.log('Starting proactive reconciliation...');
    await this.reconcileVaults();
  }

  async reconcileVaults() {
    const activeVaults = await this.prisma.vault.findMany({
      where: {
        status: { in: [VaultStatus.ACTIVE, VaultStatus.FUNDED_ASSIGNED, VaultStatus.FUNDED_UNASSIGNED] },
        isFrozen: false,
      } as any,
      include: { ledgerEntries: true },
    });

    for (const vault of activeVaults) {
      try {
        await this.checkVaultIntegrity(vault);
      } catch (error) {
        this.logger.error(`Failed to reconcile vault ${vault.id}: ${error.message}`);
      }
    }
  }

  private async checkVaultIntegrity(vault: any) {
    // 1. Calculate Ledger Balance
    const ledgerBalance = vault.ledgerEntries
      .filter((e) => e.status === TransactionStatus.CONFIRMED)
      .reduce((acc, entry) => {
        if (entry.type === LedgerEntryType.DEPOSIT) return acc + entry.amount;
        if (entry.type === LedgerEntryType.RELEASE || entry.type === LedgerEntryType.REFUND) return acc - entry.amount;
        return acc;
      }, 0);

    // 2. Check Requirement: Ledger Balance should match Vault Total (roughly)
    // Note: In a real system, you'd check specific provider transaction statuses here too.
    // For MVP, we ensure that if it's FUNDED, we have a confirmed DEPOSIT.

    const deposits = vault.ledgerEntries.filter(
      (e) => e.type === LedgerEntryType.DEPOSIT && e.status === TransactionStatus.CONFIRMED,
    );
    const totalDeposited = deposits.reduce((acc, e) => acc + e.amount, 0);

    if (totalDeposited < vault.totalAmount) {
      await this.freezeVault(vault.id, `Funding Mismatch: Expected ${vault.totalAmount}, found ${totalDeposited}`);
      return;
    }

    // 3. Check for Anomalies (e.g. Negative Balance)
    if (ledgerBalance < 0) {
      await this.freezeVault(vault.id, `Negative Balance Detected: ${ledgerBalance}`);
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
