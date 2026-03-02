import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';

@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user; // Set by AuthGuard

    if (user?.sub) {
      this.cls.set('userId', user.sub);
    }

    if (user?.role) {
      this.cls.set('role', user.role);
    }

    return next.handle();
  }
}
