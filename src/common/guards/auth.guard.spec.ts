import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let reflector: Reflector;
  let jwtService: JwtService;

  beforeEach(() => {
    reflector = new Reflector();
    jwtService = new JwtService({});
    const redisService = {} as any;
    guard = new AuthGuard(reflector, jwtService, redisService);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });
});
