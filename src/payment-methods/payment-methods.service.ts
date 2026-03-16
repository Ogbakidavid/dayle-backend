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

  async addCard(userId: string, data: {
    brand: string;
    last4: string;
    expiryMonth: number;
    expiryYear: number;
    isDefault?: boolean;
    provider?: string;
  }) {
    // Basic server-side validation
    if (data.last4.length !== 4) {
      throw new Error('Invalid card data: last4 must be 4 digits');
    }
    if (!['VISA', 'MASTERCARD', 'VERVE', 'CARD'].includes(data.brand.toUpperCase())) {
      throw new Error('Unsupported card brand');
    }

    // If isDefault is true, unset other defaults
    if (data.isDefault) {
      await this.prisma.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.prisma.paymentMethod.create({
      data: {
        userId,
        type: PaymentMethodType.CARD,
        brand: data.brand,
        last4: data.last4,
        expiryMonth: data.expiryMonth,
        expiryYear: data.expiryYear,
        isDefault: !!data.isDefault,
        provider: data.provider || 'PARTNA',
      },
    });
  }

  async addBank(userId: string, data: {
    accountName: string;
    accountNumber: string; // Masked
    bankName: string;
    bankCode: string;
    isDefault?: boolean;
    provider?: string;
  }) {
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
        accountNumber: data.accountNumber,
        bankName: data.bankName,
        bankCode: data.bankCode,
        isDefault: !!data.isDefault,
        provider: data.provider || 'PARTNA',
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
