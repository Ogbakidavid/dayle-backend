import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { Public } from '../common/decorators/public.decorator';
import * as express from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @Post('partna')
  @HttpCode(HttpStatus.OK)
  async partnaWebhook(
    @Body() payload: any,
    @Headers('x-partna-signature') signature: string,
  ) {
    await this.webhooksService.handlePartnaWebhook(payload, signature);
    return { status: 'received' };
  }

  @Public()
  @Post('paycrest')
  @HttpCode(HttpStatus.OK)
  async paycrestWebhook(
    @Body() payload: any,
    @Headers('x-paycrest-signature') signature: string,
  ) {
    await this.webhooksService.handlePaycrestWebhook(payload, signature);
    return { status: 'received' };
  }

  @Public()
  @Post('didit')
  @HttpCode(HttpStatus.OK)
  async diditWebhook(
    @Body() payload: any,
    @Headers('x-signature-v2') signature: string,
    @Req() req: express.Request,
  ) {
    const headers = req.headers;
    const body = payload;
    const rawBody = (req as any).rawBody?.toString();

    console.log('=== DIDIT WEBHOOK RECEIVED ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Headers:', JSON.stringify(headers, null, 2));
    console.log('Body:', JSON.stringify(body, null, 2));
    console.log('=== END WEBHOOK ===');

    try {
      await fs.appendFile(
        path.join(process.cwd(), 'webhook-logs.json'),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          headers,
          body,
          rawBody: !!rawBody,
        }) + '\n',
      );
    } catch (err) {
      console.error('Failed to write to webhook-logs.json:', err);
    }

    await this.webhooksService.handleDiditWebhook(payload, signature, rawBody);
    return { status: 'received' };
  }
}
