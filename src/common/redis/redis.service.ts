import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    if (this.configService.get('ENABLE_REDIS') === 'false') {
      this.logger.warn('Redis is disabled via ENABLE_REDIS flag');
      return;
    }

    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.error('REDIS_URL is not defined in environment variables');
      return;
    }

    this.redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null, // Critical for BullMQ and Upstash
      enableOfflineQueue: false,
    });

    this.redisClient.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('Redis connection error', err.message);
    });
  }

  onModuleDestroy() {
    if (this.redisClient) {
      this.redisClient.disconnect();
    }
  }

  getClient(): Redis | null {
    return this.redisClient || null;
  }

  async publish(channel: string, message: any): Promise<number> {
    if (this.redisClient.status !== 'ready') return 0;
    try {
      const payload =
        typeof message === 'string' ? message : JSON.stringify(message);
      return await this.redisClient.publish(channel, payload);
    } catch (err) {
      this.logger.warn(`Redis PUBLISH failed for channel: ${channel}`);
      return 0;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.redisClient || this.redisClient.status !== 'ready') return null;
    try {
      return await this.redisClient.get(key);
    } catch (err: any) {
      if (err.message?.includes('max requests limit exceeded')) {
        this.logger.error('Upstash Redis limit exceeded. Please upgrade or use local Redis.');
      }
      this.logger.warn(`Redis GET failed for key: ${key}`);
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<'OK' | null> {
    if (!this.redisClient || this.redisClient.status !== 'ready') return null;
    try {
      if (ttl) {
        return await this.redisClient.set(key, value, 'EX', ttl);
      }
      return await this.redisClient.set(key, value);
    } catch (err: any) {
      if (err.message?.includes('max requests limit exceeded')) {
        this.logger.error('Upstash Redis limit exceeded. Please upgrade or use local Redis.');
      }
      this.logger.warn(`Redis SET failed for key: ${key}`);
      return null;
    }
  }

  async del(key: string): Promise<number> {
    if (this.redisClient.status !== 'ready') return 0;
    try {
      return await this.redisClient.del(key);
    } catch (err) {
      this.logger.warn(`Redis DEL failed for key: ${key}`);
      return 0;
    }
  }

  async clearCacheByPattern(pattern: string): Promise<void> {
    if (this.redisClient.status !== 'ready') return;
    try {
      const keys = await this.redisClient.keys(pattern);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    } catch (err) {
      this.logger.warn(`Redis CLEAR failed for pattern: ${pattern}`);
    }
  }
}
