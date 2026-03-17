import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const User = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;

    if (data === 'id' && user && !user.id) {
      return user.sub || user.userId;
    }

    return data ? user?.[data] : user;
  },
);
