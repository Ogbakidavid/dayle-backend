import { Module, Global } from "@nestjs/common";
import { PartnaService } from "./partna.service";
import { PaycrestService } from "./paycrest.service";
import { PaymentRouter } from "./payment-router.service";
import { BlockchainService } from "./blockchain.service";

@Global()
@Module({
  providers: [PartnaService, PaycrestService, PaymentRouter, BlockchainService],
  exports: [PartnaService, PaycrestService, PaymentRouter, BlockchainService],
})
export class ServicesModule {}
