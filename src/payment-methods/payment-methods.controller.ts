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
} from '@nestjs/common';
import { PaymentMethodsService } from './payment-methods.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { PartnaService } from '../common/services/partna.service';
import { PaymentRouter } from '../common/services/payment-router.service';
import { PaycrestService } from '../common/services/paycrest.service';

@Controller('payment-methods')
@UseGuards(AuthGuard)
export class PaymentMethodsController {
  private readonly logger = new Logger(PaymentMethodsController.name);

  constructor(
    private readonly paymentMethodsService: PaymentMethodsService,
    private readonly partna: PartnaService,
    private readonly paycrest: PaycrestService,
  ) {}

  @Get()
  async list(@Req() req) {
    return this.paymentMethodsService.listByUser(req.user.id);
  }

  @Post('card')
  async addCard(@Req() req, @Body() body: any) {
    return this.paymentMethodsService.addCard(req.user.id, body);
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
    const curr = currency || 'NGN';
    
    // GHS is handled by Paycrest primarily as requested
    if (curr === 'GHS') {
      try {
        return await this.paycrest.getBanks(curr);
      } catch (e) {
        this.logger.warn(`Paycrest GHS banks failed, trying Partna fallback: ${e.message}`);
        return this.partna.getBanks(curr);
      }
    }

    // NGN and KES: Merge results from both for maximum coverage
    const [partnaBanks, paycrestBanks] = await Promise.all([
      this.partna.getBanks(curr).catch(() => []),
      this.paycrest.getBanks(curr).catch(() => []),
    ]);

    const merged = [...(partnaBanks || []), ...(paycrestBanks || [])];
    
    // Improved deduplication to handle naming variations like "OPay" vs "OPay Digital Services Limited"
    const uniqueMap = new Map();
    
    // Sort by name length descending so we prefer longer, more descriptive names as keys
    const sorted = merged.sort((a, b) => b.name.length - a.name.length);
    
    for (const bank of sorted) {
      const name = bank.name.toLowerCase();
      // Simple heuristic: if a bank already exists whose name contains this name, it's a duplicate
      // or if this name contains an existing bank name.
      let isDuplicate = false;
      for (const [existingName] of uniqueMap) {
        if (existingName.includes(name) || name.includes(existingName)) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        uniqueMap.set(name, bank);
      }
    }
    
    const unique = Array.from(uniqueMap.values());
    
    if (unique.length > 0) {
      // Final sort alphabetically for the UI
      return unique.sort((a, b) => a.name.localeCompare(b.name));
    }

    return [];
  }

  @Post('resolve-bank')
  async resolveBank(
    @Body() body: { bankCode: string; accountNumber: string; currency?: string },
  ) {
    const curr = body.currency || 'NGN';
    try {
      // Try Partna first for NGN/KES
      if (curr !== 'GHS') {
        try {
          return await this.partna.resolveBankAccount(
            body.bankCode,
            body.accountNumber,
            curr,
          );
        } catch (e) {
          this.logger.warn(`Partna resolve failed: ${e.message}, trying Paycrest fallback`);
        }
      }

      // Fallback or GHS: Try Paycrest
      return await this.paycrest.resolveBankAccount(
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
