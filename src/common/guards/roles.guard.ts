import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "../decorators/roles.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { UserRole } from "../../domain/enums";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic || !requiredRoles) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    console.log("[RolesGuard] User from request:", user);
    console.log("[RolesGuard] Required roles:", requiredRoles);

    if (!user) {
      console.log("[RolesGuard] Forbidden: No user found");
      throw new ForbiddenException({
        code: "FORBIDDEN",
        message: "User not authenticated",
      });
    }

    const hasRole = requiredRoles.includes(user.role);
    console.log("[RolesGuard] Has role check result:", hasRole);

    if (!hasRole) {
      console.log(`[RolesGuard] Forbidden: User role ${user.role} not in ${requiredRoles}`);
      throw new ForbiddenException({
        code: "FORBIDDEN",
        message: `This action requires one of the following roles: ${requiredRoles.join(", ")}`,
      });
    }

    return true;
  }
}