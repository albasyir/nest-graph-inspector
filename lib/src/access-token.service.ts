import type http from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MODULE_OPTIONS_TOKEN } from './nest-graph-inspector.config';
import type { NestGraphInspectorModuleOptions } from './nest-graph-inspector.type';
import type { HttpServeAuthorize } from './adapters/http-serve.adapter';
import { AccessAttemptLimiter } from './access-attempt-limiter';

/**
 * Query parameter carrying the access token.
 *
 * The hosted viewer loads graph data straight from the inspected application,
 * so the token has to survive a plain URL round trip.
 */
export const ACCESS_TOKEN_QUERY_PARAM = '__inspector_token';

/** Dedicated header accepted alongside `Authorization: Bearer`. */
export const ACCESS_TOKEN_HEADER = 'x-graph-inspector-token';

/** Three hours: long enough for a working session, short enough to expire. */
export const DEFAULT_ACCESS_TOKEN_TTL_MS = 3 * 60 * 60 * 1000;

const TOKEN_PREFIX = 'ngi1';
const SECRET_ENV_KEY = 'NEST_GRAPH_INSPECTOR_TOKEN_SECRET';

/**
 * Below this, a configured secret is worth brute forcing offline: a token's
 * payload and signature are both readable, so anyone holding one leaked token
 * can test candidate secrets locally, without touching the application.
 */
const MIN_SAFE_SECRET_LENGTH = 32;

/**
 * Rejections that mean a token was actually presented and did not check out.
 *
 * A missing token is not a guess, and an expired one can only be produced by
 * something that already held a real token, so neither counts toward a lockout.
 */
const GUESS_REJECTIONS: ReadonlySet<string> = new Set(['malformed', 'signature']);

export type AccessTokenPayload = {
  /** Issued at, epoch milliseconds. */
  iat: number;
  /** Expires at, epoch milliseconds. */
  exp: number;
  /** Token id, so two tokens issued in the same millisecond still differ. */
  jti: string;
};

export type AccessTokenRejection =
  | 'missing'
  | 'malformed'
  | 'signature'
  | 'expired';

export type AccessTokenVerification =
  | { ok: true; payload: AccessTokenPayload }
  | { ok: false; reason: AccessTokenRejection };

const REJECTION_MESSAGES: Record<AccessTokenRejection, string> = {
  missing:
    'Graph inspector access token is required. Open the viewer link printed in the application console.',
  malformed: 'Graph inspector access token is malformed.',
  signature: 'Graph inspector access token is not valid for this application.',
  expired:
    'Graph inspector access token has expired. Restart the application to print a fresh viewer link.',
};

/**
 * Issues and verifies the short-lived tokens that gate every inspector
 * endpoint.
 *
 * Tokens are self-describing: the payload carries its own expiry and an
 * HMAC-SHA256 signature proves the payload was issued by this process. That
 * keeps verification stateless, so an expired token dies on its own clock
 * rather than relying on server-side bookkeeping.
 */
@Injectable()
export class AccessTokenService {
  private readonly logger = new Logger(AccessTokenService.name);
  private readonly enabled: boolean;
  private readonly secret: Buffer;
  private readonly logToken: boolean;
  readonly ttlMs: number;
  readonly limiter: AccessAttemptLimiter;
  private issued: { token: string; payload: AccessTokenPayload } | undefined;

  constructor(
    @Optional()
    @Inject(MODULE_OPTIONS_TOKEN)
    options?: NestGraphInspectorModuleOptions,
  ) {
    const accessToken = options?.accessToken;

    this.enabled = accessToken?.enabled ?? true;
    this.logToken = accessToken?.logToken ?? true;
    this.ttlMs = this.normalizeTtlMs(accessToken?.ttlMs);
    this.secret = this.resolveSecret(accessToken?.secret);
    this.limiter = new AccessAttemptLimiter(accessToken?.bruteForce);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether the issued token may appear in the startup message. */
  isTokenLoggable(): boolean {
    return this.enabled && this.logToken;
  }

  /**
   * The token to hand out right now, minting a fresh one once the previous
   * token has expired.
   */
  current(): string {
    if (!this.issued || this.issued.payload.exp <= this.now()) {
      this.issued = this.mint();
    }

    return this.issued.token;
  }

  /** Expiry of the token {@link current} would return, as a Date. */
  currentExpiresAt(): Date {
    this.current();

    return new Date(this.currentPayload().exp);
  }

  private currentPayload(): AccessTokenPayload {
    if (!this.issued) {
      this.issued = this.mint();
    }

    return this.issued.payload;
  }

  verify(token: string | undefined): AccessTokenVerification {
    if (!token) {
      return { ok: false, reason: 'missing' };
    }

    const separatorIndex = token.lastIndexOf('.');
    if (separatorIndex === -1) {
      return { ok: false, reason: 'malformed' };
    }

    const signedPart = token.slice(0, separatorIndex);
    const signature = token.slice(separatorIndex + 1);

    if (!signature || !signedPart.startsWith(`${TOKEN_PREFIX}.`)) {
      return { ok: false, reason: 'malformed' };
    }

    if (!this.signatureMatches(signedPart, signature)) {
      return { ok: false, reason: 'signature' };
    }

    const payload = this.decodePayload(signedPart.slice(TOKEN_PREFIX.length + 1));
    if (!payload) {
      return { ok: false, reason: 'malformed' };
    }

    if (payload.exp <= this.now()) {
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, payload };
  }

  /**
   * Verifies the token attached to an inbound request.
   *
   * Returns `{ ok: true }` untouched when token protection is disabled, so
   * callers can wire the guard unconditionally.
   */
  authorizeRequest(
    req: http.IncomingMessage,
  ): AccessTokenVerification | { ok: true; payload?: undefined } {
    if (!this.enabled) {
      return { ok: true };
    }

    return this.verify(this.readToken(req));
  }

  /** Human readable reason, safe to return in an HTTP body. */
  rejectionMessage(reason: AccessTokenRejection): string {
    return REJECTION_MESSAGES[reason];
  }

  /**
   * Route guard applied to every endpoint the inspector installs.
   *
   * Rejections answer 401 rather than 404 so a developer holding an expired
   * link can tell "you need a fresh token" from "wrong path".
   */
  createHttpGuard(): HttpServeAuthorize {
    return (req) => {
      if (!this.enabled) {
        return { ok: true };
      }

      const clientId = this.clientId(req);
      const decision = this.limiter.check(clientId);
      if (decision.blocked) {
        return this.blockedResponse(decision.retryAfterMs);
      }

      const result = this.authorizeRequest(req);
      if (result.ok) {
        this.limiter.recordSuccess(clientId);
        return { ok: true };
      }

      if (GUESS_REJECTIONS.has(result.reason)) {
        this.limiter.recordFailure(clientId);

        if (this.limiter.check(clientId).blocked) {
          this.logger.warn(
            `Blocked ${clientId} from the graph inspector after ${this.limiter.maxFailures} invalid access tokens.`,
          );
        }
      }

      return {
        ok: false,
        response: {
          statusCode: 401,
          contentType: 'application/json; charset=utf-8',
          headers: {
            'www-authenticate': 'Bearer realm="nest-graph-inspector"',
          },
          body: {
            ok: false,
            reason: result.reason,
            error: this.rejectionMessage(result.reason),
          },
        },
      };
    };
  }

  private blockedResponse(retryAfterMs: number): ReturnType<HttpServeAuthorize> {
    const retryAfterSeconds = Math.ceil(retryAfterMs / 1_000);

    return {
      ok: false,
      response: {
        statusCode: 429,
        contentType: 'application/json; charset=utf-8',
        headers: { 'retry-after': String(retryAfterSeconds) },
        body: {
          ok: false,
          reason: 'blocked',
          error: `Too many invalid graph inspector access tokens. Try again in ${retryAfterSeconds} seconds.`,
        },
      },
    };
  }

  /**
   * Identifies the client for lockout purposes.
   *
   * Deliberately the socket address rather than a forwarded header: a header
   * is attacker-controlled, so trusting one would let a brute force rotate
   * past the lockout, and would let anyone lock out an address they choose.
   */
  private clientId(req: http.IncomingMessage): string {
    const address = req.socket?.remoteAddress ?? 'unknown';

    // Node reports IPv4 peers on a dual-stack socket as ::ffff:127.0.0.1.
    return address.startsWith('::ffff:')
      ? address.slice('::ffff:'.length)
      : address;
  }

  /**
   * Appends the current token to a URL the viewer will load.
   *
   * Skipped when the token must stay out of logs, since the viewer link is
   * printed: the operator supplies the token themselves in that setup.
   */
  appendToUrl(url: URL): URL {
    if (!this.isTokenLoggable()) {
      return url;
    }

    url.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, this.current());

    return url;
  }

  private readToken(req: http.IncomingMessage): string | undefined {
    const authorization = this.headerValue(req.headers.authorization);
    if (authorization?.toLowerCase().startsWith('bearer ')) {
      return authorization.slice('bearer '.length).trim() || undefined;
    }

    const headerToken = this.headerValue(req.headers[ACCESS_TOKEN_HEADER]);
    if (headerToken) {
      return headerToken;
    }

    // `req.url` is origin-relative, so the base only exists to satisfy URL.
    const requestUrl = new URL(req.url ?? '/', 'http://graph-inspector.invalid');

    return requestUrl.searchParams.get(ACCESS_TOKEN_QUERY_PARAM) ?? undefined;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    const header = Array.isArray(value) ? value[0] : value;

    return header?.trim() || undefined;
  }

  private mint(): { token: string; payload: AccessTokenPayload } {
    const issuedAt = this.now();
    const payload: AccessTokenPayload = {
      iat: issuedAt,
      exp: issuedAt + this.ttlMs,
      jti: randomBytes(9).toString('base64url'),
    };

    const signedPart = `${TOKEN_PREFIX}.${Buffer.from(
      JSON.stringify(payload),
    ).toString('base64url')}`;

    return {
      token: `${signedPart}.${this.sign(signedPart)}`,
      payload,
    };
  }

  private sign(signedPart: string): string {
    return createHmac('sha256', this.secret).update(signedPart).digest('base64url');
  }

  private signatureMatches(signedPart: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(signedPart));
    const actual = Buffer.from(signature);

    // timingSafeEqual throws on a length mismatch, which is itself a mismatch.
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private decodePayload(encoded: string): AccessTokenPayload | undefined {
    try {
      const payload: unknown = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      );

      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as AccessTokenPayload).iat !== 'number' ||
        typeof (payload as AccessTokenPayload).exp !== 'number'
      ) {
        return undefined;
      }

      return payload as AccessTokenPayload;
    } catch {
      return undefined;
    }
  }

  private resolveSecret(configuredSecret: string | undefined): Buffer {
    // A stable secret keeps tokens valid across restarts, which matters for
    // containerized apps that reboot more often than a developer reloads the
    // viewer. Without one, every process gets its own throwaway secret.
    const secret = configuredSecret ?? process.env[SECRET_ENV_KEY];

    if (!secret) {
      return randomBytes(32);
    }

    if (this.enabled && secret.length < MIN_SAFE_SECRET_LENGTH) {
      this.logger.warn(
        `Graph inspector access token secret is ${secret.length} characters. ` +
          `Use at least ${MIN_SAFE_SECRET_LENGTH}, or leave it unset for a random one: ` +
          'a short secret can be recovered offline from a single leaked token.',
      );
    }

    return Buffer.from(secret, 'utf8');
  }

  private normalizeTtlMs(ttlMs: number | undefined): number {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return DEFAULT_ACCESS_TOKEN_TTL_MS;
    }

    return Math.floor(ttlMs);
  }

  private now(): number {
    return Date.now();
  }
}
