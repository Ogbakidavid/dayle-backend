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
  HttpStatus
} from '@nestjs/common';
import { PaymentMethodsService } from './payment-methods.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { PartnaService } from '../common/services/partna.service';

@Controller('payment-methods')
@UseGuards(AuthGuard)
export class PaymentMethodsController {
  constructor(
    private readonly paymentMethodsService: PaymentMethodsService,
    private readonly partna: PartnaService
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

  // Partna helper endpoints
  @Get('banks')
  async getBanks() {
    return this.partna.getBanks('NGN');
  }

  @Post('resolve-bank')
  async resolveBank(@Body() body: { bankCode: string; accountNumber: string }) {
    try {
      return await this.partna.resolveBankAccount(body.bankCode, body.accountNumber);
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to resolve bank account',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
