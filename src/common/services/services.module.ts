import { Module, Global } from "@nestjs/common";
import { PartnaService } from "./partna.service";
import { PaycrestService } from "./paycrest.service";
import { PaymentRouter } from "./payment-router.service";

@Global()
@Module({
  providers: [PartnaService, PaycrestService, PaymentRouter],
  exports: [PartnaService, PaycrestService, PaymentRouter],
})
export class ServicesModule {}
