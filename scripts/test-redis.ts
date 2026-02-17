import { Logger } from '@nestjs/common';
import * as dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

async function testRedis() {
  const logger = new Logger('TestRedis');
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    logger.error('REDIS_URL not found in .env');
    return;
  }

  logger.log('Connecting to Redis...');
  const redis = new Redis(redisUrl);

  try {
    await redis.set('test-key', 'test-value', 'EX', 10);
    const val = await redis.get('test-key');
    if (val === 'test-value') {
      logger.log('✅ Redis connectivity and basic operations verified!');
    } else {
      logger.error('❌ Redis value mismatch');
    }
    await redis.del('test-key');
  } catch (err) {
    logger.error('❌ Redis test failed', err);
  } finally {
    redis.disconnect();
  }
}

testRedis();
