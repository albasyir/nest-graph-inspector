import type { Request } from 'express';

/** Who is calling: the session AuthGuard resolved from the bearer token. */
export interface SessionPrincipal {
  readonly customerId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** An HTTP request after AuthGuard: `auth` is set on every private route. */
export interface AuthenticatedRequest extends Request {
  auth?: SessionPrincipal;
}
