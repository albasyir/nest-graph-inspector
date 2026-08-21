export type AccessAttemptLimiterOptions = {
  /** Whether failed token guesses are counted at all. Defaults to `true`. */
  enabled?: boolean;
  /** Guesses tolerated inside one window before the client is blocked. */
  maxFailures?: number;
  /** How long failures accumulate before the count resets. */
  windowMs?: number;
  /** How long a blocked client stays blocked. */
  blockMs?: number;
  /** Upper bound on tracked clients, so the tracker cannot be grown forever. */
  maxTrackedClients?: number;
};

export const DEFAULT_MAX_FAILURES = 10;
export const DEFAULT_FAILURE_WINDOW_MS = 60_000;
export const DEFAULT_BLOCK_MS = 15 * 60_000;
export const DEFAULT_MAX_TRACKED_CLIENTS = 1_000;

export type AccessAttemptDecision =
  | { blocked: false }
  | { blocked: true; retryAfterMs: number };

type ClientRecord = {
  failures: number;
  windowStartedAt: number;
  lastSeenAt: number;
  blockedUntil?: number;
};

/**
 * Per-client lockout for failed access token guesses.
 *
 * Tokens are signed, so guessing one is already infeasible; this caps how fast
 * an attacker may try at all, and makes the attempt visible as a block rather
 * than an endless stream of 401s.
 *
 * The tracker is bounded on purpose: an unbounded map keyed by client address
 * would itself be a way to exhaust the host's memory.
 */
export class AccessAttemptLimiter {
  private readonly enabled: boolean;
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
  private readonly maxTrackedClients: number;
  private readonly clients = new Map<string, ClientRecord>();

  constructor(options: AccessAttemptLimiterOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.maxFailures = this.positive(options.maxFailures, DEFAULT_MAX_FAILURES);
    this.windowMs = this.positive(options.windowMs, DEFAULT_FAILURE_WINDOW_MS);
    this.blockMs = this.positive(options.blockMs, DEFAULT_BLOCK_MS);
    this.maxTrackedClients = this.positive(
      options.maxTrackedClients,
      DEFAULT_MAX_TRACKED_CLIENTS,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Whether this client is currently locked out. */
  check(clientId: string): AccessAttemptDecision {
    if (!this.enabled) {
      return { blocked: false };
    }

    const record = this.clients.get(clientId);
    if (!record?.blockedUntil) {
      return { blocked: false };
    }

    const now = Date.now();
    if (now < record.blockedUntil) {
      return { blocked: true, retryAfterMs: record.blockedUntil - now };
    }

    // The block has run its course, so the client starts over with a full
    // allowance rather than one guess away from being blocked again.
    this.clients.delete(clientId);

    return { blocked: false };
  }

  /** Counts one failed guess, blocking the client once it runs out of them. */
  recordFailure(clientId: string): void {
    if (!this.enabled) {
      return;
    }

    const now = Date.now();
    const existing = this.clients.get(clientId);
    const withinWindow =
      existing !== undefined && now - existing.windowStartedAt < this.windowMs;

    // A fresh window starts the count over, but still runs the threshold check
    // below: with a limit of one, the very first guess has to block. An active
    // block carries over, since blockMs outlives windowMs by default and
    // rolling the window must not hand a blocked client a clean slate.
    const record: ClientRecord = withinWindow
      ? existing
      : {
          failures: 0,
          windowStartedAt: now,
          lastSeenAt: now,
          blockedUntil: existing?.blockedUntil,
        };

    record.failures += 1;
    record.lastSeenAt = now;

    if (record.failures >= this.maxFailures) {
      record.blockedUntil = now + this.blockMs;
    }

    if (!withinWindow) {
      this.clients.set(clientId, record);

      if (this.clients.size > this.maxTrackedClients) {
        this.evict(now);
      }
    }
  }

  /** Clears a client's history once it proves it holds a valid token. */
  recordSuccess(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** Tracked client count, for tests and diagnostics. */
  size(): number {
    return this.clients.size;
  }

  private evict(now: number): void {
    for (const [clientId, record] of this.clients) {
      if (
        !this.isBlockedAt(record, now) &&
        now - record.windowStartedAt >= this.windowMs
      ) {
        this.clients.delete(clientId);
      }
    }

    while (this.clients.size > this.maxTrackedClients) {
      const victim = this.evictionCandidate(now);

      if (victim === undefined) {
        return;
      }

      this.clients.delete(victim);
    }
  }

  /**
   * Picks what to drop when the tracker is full.
   *
   * Blocked clients are given up last, and the one whose block ends soonest
   * goes first. Otherwise a client could flush its own block simply by filling
   * the tracker with traffic from other addresses.
   *
   * If every tracked client is blocked, one block does end early. That is the
   * price of a bounded tracker, and it costs the attacker far more traffic
   * than evicting an idle record would.
   */
  private evictionCandidate(now: number): string | undefined {
    let candidate: string | undefined;
    let candidateRank = Number.POSITIVE_INFINITY;
    let candidateIsBlocked = true;

    for (const [clientId, record] of this.clients) {
      const blocked = this.isBlockedAt(record, now);

      if (candidateIsBlocked && !blocked) {
        candidate = clientId;
        candidateRank = record.lastSeenAt;
        candidateIsBlocked = false;
        continue;
      }

      if (blocked !== candidateIsBlocked) {
        continue;
      }

      const rank = blocked ? (record.blockedUntil ?? 0) : record.lastSeenAt;
      if (rank < candidateRank) {
        candidate = clientId;
        candidateRank = rank;
      }
    }

    return candidate;
  }

  private isBlockedAt(record: ClientRecord, now: number): boolean {
    return record.blockedUntil !== undefined && now < record.blockedUntil;
  }

  private positive(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }

    return Math.floor(value);
  }
}
