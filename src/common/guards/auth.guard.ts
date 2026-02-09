import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const route = `${request.method} ${request.url}`;
    
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    console.log(`[AuthGuard] Route: ${route}, isPublic: ${isPublic}`);

    if (isPublic) {
      return true;
    }

    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "No authentication token provided",
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      request.user = payload;
    } catch {
      throw new UnauthorizedException({
        code: "UNAUTHORIZED",
        message: "Invalid or expired token",
      });
    }

    return true;
  }

  private extractTokenFromHeader(request: any): string | undefined {
    // Check Authorization header first (preferred for explicit API calls)
    const [type, token] = request.headers.authorization?.split(" ") ?? [];
    if (type === "Bearer") return token;

    // Check cookies as fallback
    if (request.cookies?.access_token) {
      return request.cookies.access_token;
    }

    return undefined;
  }
}