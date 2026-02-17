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

    this.redisClient = new Redis(redisUrl);

    this.redisClient.on('connect', () => {
      this.logger.log('Successfully connected to Redis');
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });
  }

  onModuleDestroy() {
    this.redisClient.disconnect();
  }

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<'OK'> {
    if (ttl) {
      return this.redisClient.set(key, value, 'EX', ttl);
    }
    return this.redisClient.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.redisClient.del(key);
  }

  async clearCacheByPattern(pattern: string): Promise<void> {
    const keys = await this.redisClient.keys(pattern);
    if (keys.length > 0) {
      await this.redisClient.del(...keys);
    }
  }
}
