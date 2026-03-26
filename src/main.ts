import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import * as dns from 'node:dns';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

// Force IPv4 first DNS resolution to avoid timeouts on networks with broken IPv6 (common in Node 18+)
dns.setDefaultResultOrder('ipv4first');

// BigInt serialization fix for JSON.stringify
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.use(cookieParser());

  // Security HTTP Headers (XSS, Clickjacking protection, etc.)
  app.use(
    helmet({
      // Allow cross-origin requests needed for API communication
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  // CORS — Wildcard suffixes only allowed in non-production environments for developer tooling
  const isProduction = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        process.env.FRONTEND_URL,
        process.env.ADMIN_URL,
      ].filter(Boolean);

      const isDev = !isProduction;
      const isAllowed =
        allowedOrigins.includes(origin) ||
        (isDev && origin.endsWith('.ngrok-free.dev')) ||
        (isDev && origin.endsWith('.netlify.app'));

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  });

  // API prefix - exclude root route
  app.setGlobalPrefix('api', { exclude: ['/'] });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  console.log(
    'Available DisputeTypes:',
    Object.values(require('./domain/enums').DisputeType),
  );

  await app.listen(process.env.PORT || 4000);
  console.log(
    `🚀 welcome to dayle backend running on http://localhost:${process.env.PORT || 4000}`,
  );
}

bootstrap();
