import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  Query,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { PaymentMethodsService } from './payment-methods.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { PartnaService } from '../common/services/partna.service';
import { PaymentRouter } from '../common/services/payment-router.service';
import { PaycrestService } from '../common/services/paycrest.service';
import { RedisService } from '../common/redis/redis.service';

@Controller('payment-methods')
@UseGuards(AuthGuard)
export class PaymentMethodsController {
  private readonly logger = new Logger(PaymentMethodsController.name);

  constructor(
    private readonly paymentMethodsService: PaymentMethodsService,
    private readonly partna: PartnaService,
    private readonly paycrest: PaycrestService,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  async list(@Req() req) {
    return this.paymentMethodsService.listByUser(req.user.id);
  }

  @Post('bank')
  async addBank(@Req() req, @Body() body: any) {
    return this.paymentMethodsService.addBank(req.user.id, body);
  }

  @Delete(':id')
  async remove(@Req() req, @Param('id') id: string) {
    return this.paymentMethodsService.remove(req.user.id, id);
  }

  @Post(':id/default')
  async setDefault(@Req() req, @Param('id') id: string) {
    return this.paymentMethodsService.setDefault(req.user.id, id);
  }

  @Get('banks')
  async getBanks(@Query('currency') currency?: string) {
    const curr = (currency || 'NGN').toUpperCase();

    if (!['NGN', 'KES'].includes(curr)) {
      throw new BadRequestException(`Currency ${curr} is not supported.`);
    }

    const cacheKey = `banks:${curr}`;
    try {
      const cached = await this.redisService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      this.logger.warn(`Redis cache get failed: ${e.message}`);
    }

    let finalBanks: any[] = [];

    if (curr === 'NGN') {
      // Merge Partna and Paycrest for Nigeria
      const [partnaBanks, paycrestBanks] = await Promise.all([
        this.partna.getBanks('NGN').catch(() => []),
        this.paycrest.getBanks('NGN').catch(() => []),
      ]);

      const bankMap = new Map();

      // Partna banks
      (partnaBanks as any[]).forEach((b: any) => {
        bankMap.set(b.code, {
          name: b.name,
          code: b.code,
          provider: 'partna',
        });
      });

      // Paycrest banks (merge/update)
      paycrestBanks.forEach((b: any) => {
        if (bankMap.has(b.code)) {
          bankMap.get(b.code).provider = 'both';
        } else {
          bankMap.set(b.code, {
            name: b.name || b.institutionName,
            code: b.code || b.institutionCode,
            provider: 'paycrest',
          });
        }
      });

      finalBanks = Array.from(bankMap.values());
    } else if (curr === 'KES') {
      // Paycrest only for Kenya (includes M-Pesa)
      const paycrestBanks = await this.paycrest.getBanks('KES').catch(() => []);
      finalBanks = paycrestBanks.map((b: any) => ({
        name: b.name || b.institutionName,
        code: b.code || b.institutionCode,
        provider: 'paycrest',
      }));
    }

    finalBanks.sort((a, b) => a.name.localeCompare(b.name));

    try {
      await this.redisService.set(
        cacheKey,
        JSON.stringify(finalBanks),
        24 * 60 * 60,
      );
    } catch (e) {
      this.logger.warn(`Redis cache set failed: ${e.message}`);
    }

    return finalBanks;
  }

  @Post('resolve-bank')
  async resolveBank(
    @Body()
    body: {
      bankCode: string;
      accountNumber: string;
      currency?: string;
    },
  ) {
    const curr = (body.currency || 'NGN').toUpperCase();

    if (!['NGN', 'KES'].includes(curr)) {
      throw new BadRequestException(`Currency ${curr} is not supported.`);
    }

    try {
      // 1. Try Paycrest as primary (verify-account)
      try {
        const paycrestRes = await this.paycrest.resolveBankAccount(
          body.bankCode,
          body.accountNumber,
          curr,
        );
        if (paycrestRes) return paycrestRes;
      } catch (e) {
        this.logger.warn(
          `Paycrest resolve failed: ${e.message}, trying Partna fallback`,
        );
      }

      // 2. Try Partna as fallback
      return await this.partna.resolveBankAccount(
        body.bankCode,
        body.accountNumber,
        curr,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to resolve bank account',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
