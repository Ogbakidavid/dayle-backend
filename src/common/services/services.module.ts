import { Module, Global } from '@nestjs/common';
import { PartnaService } from './partna.service';
import { PaycrestService } from './paycrest.service';
import { PaymentRouter } from './payment-router.service';
import { BlockchainService } from './blockchain.service';
import { DiditService } from './didit.service';
import { CryptoService } from './crypto.service';
import { PrismaModule } from '../../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [],
  providers: [
    PartnaService,
    PaycrestService,
    PaymentRouter,
    BlockchainService,
    DiditService,
    CryptoService,
  ],
  exports: [
    PartnaService,
    PaycrestService,
    PaymentRouter,
    BlockchainService,
    DiditService,
    CryptoService,
  ],
})
export class ServicesModule {}
