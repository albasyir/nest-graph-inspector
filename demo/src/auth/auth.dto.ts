import {
  parseJsonObject,
  requireEmail,
  requireText,
} from '../common/request-parsing';
import type { SessionRow } from '../database/database.schema';

/** What it takes to open an account. */
export interface Registration {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/** What a customer signs in with. */
export type SignInCredentials = Pick<Registration, 'email' | 'password'>;

/** A new session's bearer token: send it as `Authorization: Bearer <token>`. */
export interface SessionToken extends Pick<
  SessionRow,
  'customerId' | 'expiresAt'
> {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
}

const PASSWORD_LENGTH = { min: 8, max: 128 } as const;

/** Reads `POST /auth/register`'s body. */
export function parseRegistration(body: unknown): Registration {
  const source = parseJsonObject(body);

  return {
    name: requireText(source, 'name', { maxLength: 100 }),
    email: requireEmail(source),
    password: requireText(source, 'password', {
      trim: false,
      minLength: PASSWORD_LENGTH.min,
      maxLength: PASSWORD_LENGTH.max,
    }),
  };
}

/** Reads `POST /auth/login`'s body. */
export function parseSignInCredentials(body: unknown): SignInCredentials {
  const source = parseJsonObject(body);

  return {
    email: requireEmail(source),
    password: requireText(source, 'password', {
      trim: false,
      maxLength: PASSWORD_LENGTH.max,
    }),
  };
}
