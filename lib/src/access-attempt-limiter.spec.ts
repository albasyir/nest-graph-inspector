import {
  AccessAttemptLimiter,
  DEFAULT_BLOCK_MS,
  DEFAULT_MAX_FAILURES,
} from './access-attempt-limiter';

describe(AccessAttemptLimiter.name, () => {
  const at = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(ms);

  afterEach(() => jest.restoreAllMocks());

  it('allows a client that has never failed', () => {
    expect(new AccessAttemptLimiter().check('10.0.0.1')).toEqual({
      blocked: false,
    });
  });

  it('allows failures up to the limit, then blocks', () => {
    const limiter = new AccessAttemptLimiter({ maxFailures: 3 });

    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });

    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });
  });

  it('reports how long a blocked client has to wait', () => {
    at(1_000);
    const limiter = new AccessAttemptLimiter({
      maxFailures: 1,
      blockMs: 60_000,
    });
    limiter.recordFailure('10.0.0.1');

    at(21_000);
    expect(limiter.check('10.0.0.1')).toEqual({
      blocked: true,
      retryAfterMs: 40_000,
    });
  });

  it('blocks only the client that failed', () => {
    const limiter = new AccessAttemptLimiter({ maxFailures: 1 });
    limiter.recordFailure('10.0.0.1');

    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });
    expect(limiter.check('10.0.0.2')).toEqual({ blocked: false });
  });

  it('lets a client back in with a full allowance once the block expires', () => {
    at(1_000);
    const limiter = new AccessAttemptLimiter({
      maxFailures: 2,
      blockMs: 10_000,
    });
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });

    at(11_001);
    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });

    // One failure must not put the client straight back into a block.
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });
  });

  it('keeps an active block when the failure window rolls over', () => {
    at(1_000);
    // blockMs outliving windowMs is the default shape, not an edge case.
    const limiter = new AccessAttemptLimiter({
      maxFailures: 1,
      windowMs: 1_000,
      blockMs: 60_000,
    });
    limiter.recordFailure('10.0.0.1');

    at(2_500);
    limiter.recordFailure('10.0.0.1');

    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });
  });

  it('forgets failures that fall outside the window', () => {
    at(1_000);
    const limiter = new AccessAttemptLimiter({
      maxFailures: 2,
      windowMs: 5_000,
    });
    limiter.recordFailure('10.0.0.1');

    at(7_000);
    limiter.recordFailure('10.0.0.1');

    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });
  });

  it('clears a client history once it presents a valid token', () => {
    const limiter = new AccessAttemptLimiter({ maxFailures: 2 });
    limiter.recordFailure('10.0.0.1');
    limiter.recordSuccess('10.0.0.1');
    limiter.recordFailure('10.0.0.1');

    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });
    expect(limiter.size()).toBe(1);
  });

  it('keeps the tracked client count bounded', () => {
    const limiter = new AccessAttemptLimiter({ maxTrackedClients: 25 });

    for (let index = 0; index < 500; index += 1) {
      limiter.recordFailure(`10.0.${Math.floor(index / 256)}.${index % 256}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(25);
  });

  it('does not let traffic from other addresses flush an active block', () => {
    at(1_000);
    const limiter = new AccessAttemptLimiter({
      maxFailures: 2,
      maxTrackedClients: 5,
      windowMs: 600_000,
      blockMs: 600_000,
    });
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');
    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });

    // Well past the cap, but none of these reach the block threshold, so the
    // tracker has plenty of unblocked records to give up first.
    for (let index = 0; index < 50; index += 1) {
      at(1_000 + index);
      limiter.recordFailure(`10.9.0.${index}`);
    }

    at(2_000);
    expect(limiter.check('10.0.0.1')).toMatchObject({ blocked: true });
    expect(limiter.size()).toBeLessThanOrEqual(5);
  });

  it('counts nothing when the limiter is turned off', () => {
    const limiter = new AccessAttemptLimiter({
      enabled: false,
      maxFailures: 1,
    });
    limiter.recordFailure('10.0.0.1');
    limiter.recordFailure('10.0.0.1');

    expect(limiter.isEnabled()).toBe(false);
    expect(limiter.check('10.0.0.1')).toEqual({ blocked: false });
  });

  it('falls back to defaults for unusable settings', () => {
    const limiter = new AccessAttemptLimiter({
      maxFailures: 0,
      blockMs: Number.NaN,
    });

    expect(limiter.maxFailures).toBe(DEFAULT_MAX_FAILURES);
    expect(limiter.blockMs).toBe(DEFAULT_BLOCK_MS);
  });
});
