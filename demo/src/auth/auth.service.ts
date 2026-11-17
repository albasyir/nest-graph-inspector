import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { SessionPrincipal } from '../common/authenticated-request';
import type { Customer } from '../customer/customer.dto';
import { CustomerService } from '../customer/customer.service';
import type { Registration, SessionToken, SignInCredentials } from './auth.dto';
import { AuthRepository } from './auth.repository';
import { PasswordHasher } from './password-hasher';

/** How long a session lasts. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

/**
 * Checked against when the email is unknown, so a failed sign-in costs the
 * same whether or not the account exists. A hash of random bytes nobody
 * knows; it matches no password.
 */
const UNKNOWN_ACCOUNT_HASH =
  'scrypt$16384$8$1$g8khee1cSnnWa1hFtC1NRg$JV2pbDlp8RT5VQv73jqegfD5GD5wxiW8VjCLAAGFZ7Yl_c4ZZTfz36f02y37QFhAd4HnHIfc7NxetNWKu2te_A';

/**
 * Accounts and sessions.
 *
 * Passwords are kept only as scrypt hashes. Signing in issues an opaque
 * bearer token — 32 random bytes — of which only a SHA-256 digest is stored,
 * so the sessions table holds nothing a caller could present. Every private
 * route reaches `authenticate` through the global AuthGuard.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly auth: AuthRepository,
    private readonly customers: CustomerService,
    private readonly passwords: PasswordHasher,
  ) {}

  /**
   * Opens an account: a customer, and the hash of their password.
   *
   * @throws ConflictException when the email address is already registered
   */
  async register(registration: Registration): Promise<Customer> {
    // Hash first: if hashing failed after the customer existed, they could
    // never sign in.
    const passwordHash = await this.passwords.hash(registration.password);
    const customer = await this.customers.createCustomer({
      name: registration.name,
      email: registration.email,
      phone: null,
    });

    await this.auth.insertCredential({
      customerId: customer.id,
      passwordHash,
    });

    return customer;
  }

  /**
   * Signs a customer in and starts a session.
   *
   * @throws UnauthorizedException when the email or the password is wrong —
   * one answer for both, so it tells nobody which accounts exist
   */
  async login(credentials: SignInCredentials): Promise<SessionToken> {
    const customer = await this.customers.findByEmail(credentials.email);
    // Look a credential up and check a password even for an unknown email,
    // so the timing does not tell whether the account exists either.
    const credential = await this.auth.findCredential(customer?.id ?? '');
    const matches = await this.passwords.verify(
      credentials.password,
      credential?.passwordHash ?? UNKNOWN_ACCOUNT_HASH,
    );

    if (!customer || !credential || !matches) {
      throw new UnauthorizedException('Email or password is incorrect');
    }

    const accessToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    await this.auth.insertSession({
      customerId: customer.id,
      tokenHash: digest(accessToken),
      expiresAt,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresAt,
      customerId: customer.id,
    };
  }

  /**
   * The session a bearer token belongs to. An expired session is deleted on
   * the way out.
   *
   * @throws UnauthorizedException when the token is unknown or expired
   */
  async authenticate(accessToken: string): Promise<SessionPrincipal> {
    const session = await this.auth.findSessionByTokenHash(digest(accessToken));

    if (!session) {
      throw new UnauthorizedException(
        'This token is not signed in; sign in again',
      );
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.auth.deleteSession(session.id);
      throw new UnauthorizedException('This session expired; sign in again');
    }

    return {
      customerId: session.customerId,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  /** Ends a session: its token stops working at once. */
  async logout(sessionId: string): Promise<void> {
    await this.auth.deleteSession(sessionId);
  }
}

function digest(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('hex');
}
