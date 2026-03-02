import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { User } from '../common/decorators/user.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  async list(@User('id') userId: string) {
    return this.notificationsService.getNotifications(userId);
  }

  @Post('read-all')
  async markAllAsRead(@User('id') userId: string) {
    return this.notificationsService.markAllAsRead(userId);
  }

  @Post(':id/read')
  async markAsRead(@User('id') userId: string, @Param('id') id: string) {
    return this.notificationsService.markAsRead(userId, id);
  }

  @Get('preferences')
  async getPreferences(@User('id') userId: string) {
    return this.notificationsService.getPreferences(userId);
  }

  @Patch('preferences')
  async updatePreferences(@User('id') userId: string, @Body() body: any) {
    return this.notificationsService.updatePreferences(userId, body);
  }

  // Telegram
  @Get('telegram/link-token')
  async getTelegramLinkToken(@User('id') userId: string) {
    return this.notificationsService.getTelegramLinkToken(userId);
  }

  @Post('telegram/connect')
  async simulateTelegramConnect(
    @User('id') userId: string,
    @Body('username') username: string,
  ) {
    return this.notificationsService.simulateTelegramConnect(userId, username);
  }

  @Post('telegram/disconnect')
  async disconnectTelegram(@User('id') userId: string) {
    return this.notificationsService.disconnectTelegram(userId);
  }

  // WhatsApp
  @Post('whatsapp/start-verification')
  async startWhatsAppVerification(
    @User('id') userId: string,
    @Body('phone') phone: string,
  ) {
    return this.notificationsService.startWhatsAppVerification(userId, phone);
  }

  @Post('whatsapp/confirm-verification')
  async confirmWhatsAppVerification(
    @User('id') userId: string,
    @Body() body: { code: string; consent: boolean },
  ) {
    return this.notificationsService.confirmWhatsAppVerification(
      userId,
      body.code,
      body.consent,
    );
  }

  @Post('whatsapp/disable')
  async disableWhatsApp(@User('id') userId: string) {
    return this.notificationsService.disableWhatsApp(userId);
  }

  @Post('test-seed')
  async createTestNotification(@User('id') userId: string) {
    return this.notificationsService.createTestNotification(userId);
  }
}
