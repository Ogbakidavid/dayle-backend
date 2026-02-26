import { Module, Global } from "@nestjs/common";
import { PartnaService } from "./partna.service";
import { PaycrestService } from "./paycrest.service";
import { PaymentRouter } from "./payment-router.service";
import { BlockchainService } from "./blockchain.service";
import { DiditService } from "./didit.service";

@Global()
@Module({
  providers: [PartnaService, PaycrestService, PaymentRouter, BlockchainService, DiditService],
  exports: [PartnaService, PaycrestService, PaymentRouter, BlockchainService, DiditService],
})
export class ServicesModule {}
