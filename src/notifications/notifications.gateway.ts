import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';
import { OnModuleInit } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*', // In production, restrict to your frontend domain
    credentials: true,
  },
  namespace: 'notifications',
})
@Injectable()
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private redisService: RedisService,
  ) {}

  onModuleInit() {
    const redis = this.redisService.getClient();
    if (!redis) {
      this.logger.warn(
        'Redis client not available. Real-time notifications via Pub/Sub will be disabled.',
      );
      return;
    }

    // ioredis recommends a separate client for SUBSCRIBE.
    const subClient = redis.duplicate();

    subClient.on('ready', () => {
      subClient.subscribe(
        'vault.funded',
        'vault.released',
        'vault.refunded',
        'vault.status_updated',
        (err, count) => {
          if (err) {
            this.logger.error(
              'Failed to subscribe to Redis channels',
              err.message,
            );
            return;
          }
          this.logger.log(`Subscribed to ${count} Redis channels`);
        },
      );
    });

    subClient.on('error', (err) => {
      this.logger.error('Redis subscription client error', err.message);
    });

    subClient.on('message', (channel, message) => {
      const payload = JSON.parse(message);

      if (channel === 'vault.funded') {
        // Alert both client and freelancer if they are connected
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'notification', {
            type: 'payment',
            title: 'Vault Funded',
            message: `Your vault ${payload.vaultId} has been successfully funded.`,
            action: `/client/vault/${payload.vaultId}`,
          });
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'notification', {
            type: 'payment',
            title: 'New Funding',
            message: `Vault ${payload.vaultId} is now funded and ready for work!`,
            action: `/freelancer/vault/${payload.vaultId}`,
          });
          
        const eventData = {
          vaultId: payload.vaultId,
          status: payload.status || 'FUNDED',
          timestamp: new Date().toISOString()
        };
        
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'vault_updated', eventData);
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'vault_updated', eventData);
            
      } else if (channel === 'vault.released') {
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'notification', {
            type: 'success',
            title: 'Funds Released',
            message: `Funds for vault "${payload.title}" have been released to the freelancer.`,
            action: `/client/vault/${payload.vaultId}`,
          });
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'notification', {
            type: 'success',
            title: 'Payment Received',
            message: `Funds for vault "${payload.title}" have been released to your balance!`,
            action: `/freelancer/vault/${payload.vaultId}`,
          });

        const eventData = {
          vaultId: payload.vaultId,
          status: payload.status || 'RELEASED',
          timestamp: new Date().toISOString()
        };
        
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'vault_updated', eventData);
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'vault_updated', eventData);
          
      } else if (channel === 'vault.refunded') {
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'notification', {
            type: 'info',
            title: 'Vault Refunded',
            message: `Funds for vault "${payload.title}" have been refunded to your wallet.`,
            action: `/client/vault/${payload.vaultId}`,
          });
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'notification', {
            type: 'info',
            title: 'Vault Cancelled',
            message: `The vault "${payload.title}" has been cancelled and refunded.`,
            action: `/freelancer/vault/${payload.vaultId}`,
          });

        const eventData = {
          vaultId: payload.vaultId,
          status: payload.status || 'REFUNDED',
          timestamp: new Date().toISOString()
        };
        
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'vault_updated', eventData);
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'vault_updated', eventData);
          
      } else if (channel === 'vault.status_updated') {
        const eventData = {
          vaultId: payload.vaultId,
          status: payload.status,
          timestamp: new Date().toISOString()
        };
        
        if (payload.clientId)
          this.sendToUser(payload.clientId, 'vault_updated', eventData);
        if (payload.freelancerId)
          this.sendToUser(payload.freelancerId, 'vault_updated', eventData);
      }
    });
  }

  async handleConnection(client: Socket) {
    try {
      // Get token from handshake auth or query or cookie
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split(' ')[1] ||
        this.extractFromCookie(client.handshake.headers?.cookie);

      if (!token) {
        this.logger.warn(
          `Client ${client.id} connected without token, disconnecting...`,
        );
        client.disconnect();
        return;
      }

      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get('JWT_SECRET'),
      });

      const userId = payload.sub || payload.id;
      if (!userId) {
        this.logger.warn(
          `Client ${client.id} token has no userId, disconnecting...`,
        );
        client.disconnect();
        return;
      }

      // Join a room specific to the user
      client.join(`user_${userId}`);
      this.logger.log(
        `Client ${client.id} (User: ${userId}) connected and joined room user_${userId}`,
      );
    } catch (err) {
      this.logger.error(
        `Connection error for client ${client.id}: ${err.message}`,
      );
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client ${client.id} disconnected`);
  }

  sendToUser(userId: string, event: string, payload: any) {
    this.server.to(`user_${userId}`).emit(event, payload);
    this.logger.log(`Sent ${event} to user_${userId}`);
  }

  private extractFromCookie(cookieString?: string): string | null {
    if (!cookieString) return null;
    const match = cookieString.match(/access_token=([^;]+)/);
    return match ? match[1] : null;
  }
}
