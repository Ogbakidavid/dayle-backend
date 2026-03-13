import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const route = `${request.method} ${request.url}`;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    console.log(`[AuthGuard] Route: ${route}, isPublic: ${isPublic}`);
    console.log('[AuthGuard] All cookies:', JSON.stringify(request.cookies));
    console.log('[AuthGuard] All headers:', JSON.stringify(request.headers));

    if (isPublic) {
      return true;
    }

    const token = this.extractTokenFromHeader(request);
    console.log('[AuthGuard] Extracted token:', token ? 'exists' : 'null');

    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'No authentication token provided',
      });
    }

    // Check Redis blacklist
    const isBlacklisted = await this.redis.get(`blacklist:${token}`);
    if (isBlacklisted) {
      console.log('[AuthGuard] Token is blacklisted');
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'This session has been revoked',
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      request.user = payload;
    } catch {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
    }

    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    // Check Authorization header first (preferred for explicit API calls)
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer') {
      console.log('[AuthGuard] Token found in Authorization header');
      return token;
    }

    // Check cookies as fallback
    if (request.cookies?.access_token) {
      console.log('[AuthGuard] Token found in access_token cookie');
      return request.cookies.access_token;
    }

    console.log('[AuthGuard] No token found in headers or cookies');
    return undefined;
  }
}
