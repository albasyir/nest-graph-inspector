import http from 'node:http';
import {
  ACCESS_TOKEN_HEADER,
  ACCESS_TOKEN_QUERY_PARAM,
  AccessTokenService,
  DEFAULT_ACCESS_TOKEN_TTL_MS,
} from './access-token.service';

/**
 * Minimal stand-in for an inbound request the guard inspects.
 *
 * The socket address matters: it is how the guard tells callers apart, so
 * omitting it would put every case in one lockout bucket.
 */
function request(options: {
  url?: string;
  headers?: http.IncomingHttpHeaders;
  remoteAddress?: string;
}): http.IncomingMessage {
  return {
    url: options.url ?? '/__graph-inspector/output.json',
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '10.0.0.1' },
  } as http.IncomingMessage;
}

const WRONG_TOKEN = { authorization: 'Bearer ngi1.eyJhIjoxfQ.wrong' };

describe(AccessTokenService.name, () => {
  // Several cases drive the clock forward; leaving it frozen would silently
  // change what later cases mean.
  afterEach(() => jest.restoreAllMocks());

  it('issues a token that verifies against the issuing service', () => {
    const service = new AccessTokenService();

    expect(service.verify(service.current())).toMatchObject({ ok: true });
  });

  /**
   * A token travels inside a URL, so every character it is made of has to
   * survive that trip. A runtime that ignores the digest encoding hands back
   * raw bytes, and a token carrying raw bytes arrives corrupted.
   */
  it('issues a token made only of characters a url carries unchanged', () => {
    const token = new AccessTokenService().current();

    expect(token).toMatch(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('verifies a token that made a round trip through a url', () => {
    const service = new AccessTokenService();
    const url = new URL('http://localhost:53371/__graph-inspector');
    url.searchParams.set(ACCESS_TOKEN_QUERY_PARAM, service.current());

    const received = new URL(url.toString()).searchParams.get(
      ACCESS_TOKEN_QUERY_PARAM,
    );

    expect(received).toBe(service.current());
    expect(service.verify(received!)).toMatchObject({ ok: true });
  });

  it('expires a token once its lifetime has passed', () => {
    const issuedAt = Date.parse('2026-08-15T13:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(issuedAt);

    const service = new AccessTokenService({
      accessToken: { ttlMs: 3 * 60 * 60 * 1000 },
    });
    const token = service.current();

    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-15T15:59:59.000Z'));
    expect(service.verify(token)).toMatchObject({ ok: true });

    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-15T16:00:00.000Z'));
    expect(service.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('mints a replacement once the previous token has expired', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const service = new AccessTokenService({ accessToken: { ttlMs: 100 } });
    const first = service.current();

    // Stable while it is still valid.
    expect(service.current()).toBe(first);

    jest.spyOn(Date, 'now').mockReturnValue(2_000);
    const second = service.current();

    expect(second).not.toBe(first);
    expect(service.verify(second)).toMatchObject({ ok: true });
    expect(service.verify(first)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token issued by a service with a different secret', () => {
    const service = new AccessTokenService({
      accessToken: { secret: 'first-application' },
    });
    const other = new AccessTokenService({
      accessToken: { secret: 'second-application' },
    });

    expect(service.verify(other.current())).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a token whose payload was edited to extend its expiry', () => {
    const service = new AccessTokenService({ accessToken: { ttlMs: 1_000 } });
    const [prefix, payload, signature] = service.current().split('.');
    const forged = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    forged.exp = Date.now() + 10 * 60 * 60 * 1000;

    const tampered = [
      prefix,
      Buffer.from(JSON.stringify(forged)).toString('base64url'),
      signature,
    ].join('.');

    expect(service.verify(tampered)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it.each([
    ['an empty token', ''],
    ['a token with no signature', 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0'],
    ['a token with an unknown prefix', 'other.payload.signature'],
  ])('rejects %s', (_label, token) => {
    const service = new AccessTokenService();
    const result = service.verify(token);

    expect(result.ok).toBe(false);
  });

  it('keeps tokens valid across services that share a configured secret', () => {
    const secret = 'shared-across-restarts';
    const before = new AccessTokenService({ accessToken: { secret } });
    const afterRestart = new AccessTokenService({ accessToken: { secret } });

    expect(afterRestart.verify(before.current())).toMatchObject({ ok: true });
  });

  it('falls back to the default lifetime for an unusable ttl', () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(new AccessTokenService({ accessToken: { ttlMs } }).ttlMs).toBe(
        DEFAULT_ACCESS_TOKEN_TTL_MS,
      );
    }
  });

  describe('request authorization', () => {
    let service: AccessTokenService;

    beforeEach(() => {
      service = new AccessTokenService({
        accessToken: { secret: 'authorization-tests' },
      });
    });

    it.each([
      [
        'an Authorization bearer header',
        (token: string) => ({ headers: { authorization: `Bearer ${token}` } }),
      ],
      [
        'the dedicated header',
        (token: string) => ({ headers: { [ACCESS_TOKEN_HEADER]: token } }),
      ],
      [
        'the query parameter',
        (token: string) => ({
          url: `/__graph-inspector/output.json?${ACCESS_TOKEN_QUERY_PARAM}=${token}`,
        }),
      ],
    ])('reads the token from %s', (_label, build) => {
      const result = service.authorizeRequest(
        request(build(service.current())),
      );

      expect(result.ok).toBe(true);
    });

    it('reports a missing token when the request carries none', () => {
      expect(service.authorizeRequest(request({}))).toEqual({
        ok: false,
        reason: 'missing',
      });
    });

    it('authorizes every request when token protection is turned off', () => {
      const disabled = new AccessTokenService({
        accessToken: { enabled: false },
      });

      expect(disabled.authorizeRequest(request({}))).toEqual({ ok: true });
    });
  });

  describe('http guard', () => {
    it('answers 401 with the reason when a token is missing', () => {
      const guard = new AccessTokenService().createHttpGuard();
      const result = guard(request({}));

      expect(result).toMatchObject({
        ok: false,
        response: {
          statusCode: 401,
          headers: {
            'www-authenticate': 'Bearer realm="nest-graph-inspector"',
          },
          body: { ok: false, reason: 'missing' },
        },
      });
    });

    it('answers 429 with retry-after once the caller is locked out', () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000);
      const service = new AccessTokenService({
        accessToken: { bruteForce: { maxFailures: 1, blockMs: 30_000 } },
      });
      const guard = service.createHttpGuard();
      const guessing = request({ headers: WRONG_TOKEN });

      // The first guess is refused and is what trips the lockout.
      expect(guard(guessing)).toMatchObject({
        ok: false,
        response: { statusCode: 401, body: { reason: 'signature' } },
      });

      expect(guard(guessing)).toMatchObject({
        ok: false,
        response: {
          statusCode: 429,
          headers: { 'retry-after': '30' },
          body: { reason: 'blocked' },
        },
      });

      // Remaining block time rounds up rather than reporting zero seconds.
      jest.spyOn(Date, 'now').mockReturnValue(29_500);
      expect(guard(guessing)).toMatchObject({
        response: { headers: { 'retry-after': '2' } },
      });
    });

    it('locks out one caller without affecting another', () => {
      const service = new AccessTokenService({
        accessToken: { bruteForce: { maxFailures: 1, blockMs: 30_000 } },
      });
      const guard = service.createHttpGuard();

      guard(request({ headers: WRONG_TOKEN, remoteAddress: '10.0.0.1' }));

      expect(
        guard(request({ headers: WRONG_TOKEN, remoteAddress: '10.0.0.1' })),
      ).toMatchObject({ response: { statusCode: 429 } });
      expect(
        guard(request({ headers: WRONG_TOKEN, remoteAddress: '10.0.0.2' })),
      ).toMatchObject({ response: { statusCode: 401 } });
    });

    it('treats an IPv4-mapped address as the same caller', () => {
      const service = new AccessTokenService({
        accessToken: { bruteForce: { maxFailures: 1, blockMs: 30_000 } },
      });
      const guard = service.createHttpGuard();

      guard(
        request({ headers: WRONG_TOKEN, remoteAddress: '::ffff:10.0.0.1' }),
      );

      expect(
        guard(request({ headers: WRONG_TOKEN, remoteAddress: '10.0.0.1' })),
      ).toMatchObject({ response: { statusCode: 429 } });
    });

    it('lets a valid token through', () => {
      const service = new AccessTokenService();
      const guard = service.createHttpGuard();

      expect(
        guard(
          request({ headers: { authorization: `Bearer ${service.current()}` } }),
        ),
      ).toEqual({ ok: true });
    });
  });

  describe('viewer link', () => {
    it('appends the token to the graph endpoint url', () => {
      const service = new AccessTokenService();
      const url = service.appendToUrl(
        new URL('http://127.0.0.1:53371/__graph-inspector'),
      );

      expect(
        service.verify(url.searchParams.get(ACCESS_TOKEN_QUERY_PARAM)!),
      ).toMatchObject({ ok: true });
    });

    it('leaves the url untouched when token protection is turned off', () => {
      const service = new AccessTokenService({
        accessToken: { enabled: false },
      });
      const url = service.appendToUrl(
        new URL('http://127.0.0.1:53371/__graph-inspector'),
      );

      expect(url.toString()).toBe('http://127.0.0.1:53371/__graph-inspector');
    });
  });
});
