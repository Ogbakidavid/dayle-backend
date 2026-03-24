import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { RatesService } from './rates.service';
import { IsPublic } from '../common/decorators/public.decorator';

@Throttle({ rates: { limit: 2000, ttl: 60000 } })
@Controller('rates')
export class RatesController {
  constructor(private readonly ratesService: RatesService) {}

  @Get('display')
  @IsPublic()
  async getDisplayRate(
    @Query('currency') currency: string,
    @Query('amount') amount: string,
  ) {
    if (!amount) throw new BadRequestException('Amount is required');
    return this.ratesService.getDisplayRate(currency, parseFloat(amount));
  }

  @Get('transaction')
  async getTransactionRate(
    @Query('currency') currency: string,
    @Query('amount') amount: string,
    @Query('vaultId') vaultId: string,
    @Query('type') type: 'funding' | 'withdrawal',
  ) {
    const usdAmount = parseFloat(amount);
    if (isNaN(usdAmount)) throw new BadRequestException('Invalid amount');
    if (!vaultId) throw new BadRequestException('Vault ID is required for transactions');
    if (!['funding', 'withdrawal'].includes(type)) {
      throw new BadRequestException('Invalid transaction type');
    }

    const rateResult = await this.ratesService.getTransactionRate(currency, usdAmount, vaultId, type);
    
    return {
      currency: currency.toUpperCase(),
      usdAmount,
      rate: rateResult.rate,
      convertedAmount: type === 'funding' ? usdAmount / rateResult.rate : usdAmount * rateResult.rate,
      vaultId,
      type,
      timestamp: new Date().toISOString(),
    };
  }
}
