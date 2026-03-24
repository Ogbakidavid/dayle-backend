import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentMethodType } from '../domain/enums';

@Injectable()
export class PaymentMethodsService {
  private readonly logger = new Logger(PaymentMethodsService.name);

  constructor(private prisma: PrismaService) {}

  async listByUser(userId: string) {
    return this.prisma.paymentMethod.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }


  async addBank(
    userId: string,
    data: {
      accountName: string;
      accountNumber: string; // Masked
      bankName: string;
      bankCode: string;
      isDefault?: boolean;
      provider?: string;
    },
  ) {
    if (data.isDefault) {
      await this.prisma.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.paymentMethod.create({
      data: {
        userId,
        type: PaymentMethodType.BANK_TRANSFER,
        accountName: data.accountName,
        // For withdrawals, we need the full account number. 
        // We store it as provided, but also keep last4 for secure display.
        // * Disclaimer: Full account numbers are kept for manual and automated withdrawal flows only.
        accountNumber: data.accountNumber.replace(/\D/g, ''),
        last4: data.accountNumber.replace(/\D/g, '').slice(-4),
        bankName: data.bankName,
        bankCode: data.bankCode,
        isDefault: !!data.isDefault,
        provider: data.provider || 'PARTNA',
      },
    });
  }

  async addMpesa(
    userId: string,
    data: {
      phoneNumber: string; // +254XXXXXXXXX
      accountName: string;
      isDefault?: boolean;
    },
  ) {
    // Validate format: +254 followed by exactly 9 digits
    const mpesaRegex = /^\+254\d{9}$/;
    if (!mpesaRegex.test(data.phoneNumber)) {
      throw new Error('Invalid M-Pesa number. Format must be +254 followed by 9 digits.');
    }

    if (data.isDefault) {
      await this.prisma.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.paymentMethod.create({
      data: {
        userId,
        type: PaymentMethodType.BANK_TRANSFER,
        accountName: data.accountName,
        accountNumber: data.phoneNumber,
        last4: data.phoneNumber.slice(-4),
        bankName: 'MPESA',
        bankCode: 'MPESA',
        isDefault: !!data.isDefault,
        provider: 'PAYCREST',
      },
    });
  }

  async remove(userId: string, id: string) {
    return this.prisma.paymentMethod.delete({
      where: { id, userId },
    });
  }

  async setDefault(userId: string, id: string) {
    await this.prisma.$transaction([
      this.prisma.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      }),
      this.prisma.paymentMethod.update({
        where: { id, userId },
        data: { isDefault: true },
      }),
    ]);
    return { success: true };
  }
}
