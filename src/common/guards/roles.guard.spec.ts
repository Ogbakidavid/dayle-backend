import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });
  it('should be defined', () => {
    expect(guard).toBeDefined();
  });
});
