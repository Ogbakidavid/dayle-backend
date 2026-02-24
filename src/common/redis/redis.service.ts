import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redisClient: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.error('REDIS_URL is not defined in environment variables');
      return;
    }

    this.redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // Prevents hanging operations when disconnected
    });

    this.redisClient.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });

    this.redisClient.on('error', (err) => {
      // Optional: keep logging minimal after first fail to avoid log spam
      this.logger.error('Redis connection error', err.message);
    });
  }

  onModuleDestroy() {
    this.redisClient.disconnect();
  }

  async get(key: string): Promise<string | null> {
    if (this.redisClient.status !== 'ready') return null;
    try {
      return await this.redisClient.get(key);
    } catch (err) {
      this.logger.warn(`Redis GET failed for key: ${key}`);
      return null;
    }
  }

  async set(key: string, value: string, ttl?: number): Promise<'OK' | null> {
    if (this.redisClient.status !== 'ready') return null;
    try {
      if (ttl) {
        return await this.redisClient.set(key, value, 'EX', ttl);
      }
      return await this.redisClient.set(key, value);
    } catch (err) {
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
