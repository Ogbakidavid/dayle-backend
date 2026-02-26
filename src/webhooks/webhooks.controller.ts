import { Controller, Post, Body, Headers, HttpCode, HttpStatus } from "@nestjs/common";
import { WebhooksService } from "./webhooks.service";
import { Public } from "../common/decorators/public.decorator";

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @Post("partna")
  @HttpCode(HttpStatus.OK)
  async partnaWebhook(
    @Body() payload: any,
    @Headers("x-partna-signature") signature: string,
  ) {
    await this.webhooksService.handlePartnaWebhook(payload, signature);
    return { status: "received" };
  }

  @Public()
  @Post("paycrest")
  @HttpCode(HttpStatus.OK)
  async paycrestWebhook(
    @Body() payload: any,
    @Headers("x-paycrest-signature") signature: string,
  ) {
    await this.webhooksService.handlePaycrestWebhook(payload, signature);
    return { status: "received" };
  }

  @Public()
  @Post("didit")
  @HttpCode(HttpStatus.OK)
  async diditWebhook(
    @Body() payload: any,
    @Headers("x-signature-v2") signature: string,
  ) {
    await this.webhooksService.handleDiditWebhook(payload, signature);
    return { status: "received" };
  }
}
