import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type {
  AuthenticatedRequest,
  SessionPrincipal,
} from './authenticated-request';

/**
 * The session AuthGuard attached to the request. A private route always has
 * one; reaching this without it means a `@Public()` route asked for a
 * customer, which is answered as an unauthenticated call, not ignored.
 */
function principalOf(context: ExecutionContext): SessionPrincipal {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (!request.auth) {
    throw new UnauthorizedException('Sign in to use this route');
  }

  return request.auth;
}

/** The signed-in customer's id. */
export const CurrentCustomerId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    principalOf(context).customerId,
);

/** The signed-in session. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionPrincipal =>
    principalOf(context),
);
