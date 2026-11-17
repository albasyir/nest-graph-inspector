import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../common/authenticated-request';
import { IS_PUBLIC_ROUTE } from '../common/public.decorator';
import { AuthService } from './auth.service';

/**
 * The global sign-in check, registered by AuthModule as `APP_GUARD`: every
 * route needs a valid bearer token unless it is marked `@Public()`. The
 * session it finds is attached to the request for `@CurrentCustomerId()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.auth = await this.authService.authenticate(
      readBearerToken(request.headers.authorization),
    );

    return true;
  }
}

function readBearerToken(authorization: string | undefined): string {
  if (!authorization) {
    throw new UnauthorizedException(
      'Sign in first, then send Authorization: Bearer <token>',
    );
  }

  const [scheme, token, ...rest] = authorization.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length) {
    throw new UnauthorizedException(
      'The Authorization header must be "Bearer <token>"',
    );
  }

  return token;
}
