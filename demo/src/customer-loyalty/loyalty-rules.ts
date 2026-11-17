import type { LoyaltyTier } from '../database/database.schema';

/** One loyalty tier: where it starts, and the discount it gives. */
export interface TierRule {
  readonly tier: LoyaltyTier;
  /** Lifetime points from which a customer holds this tier. */
  readonly minLifetimePoints: number;
  /** Whole percent taken off at checkout, after any voucher. */
  readonly discountPercent: number;
}

/**
 * The tiers, lowest first. A customer holds the highest tier their lifetime
 * points reach; the lowest starts at zero, so everyone holds one — the type
 * says there is always a first.
 */
export const TIER_RULES: readonly [TierRule, ...TierRule[]] = [
  { tier: 'BRONZE', minLifetimePoints: 0, discountPercent: 0 },
  { tier: 'SILVER', minLifetimePoints: 1_000, discountPercent: 5 },
  { tier: 'GOLD', minLifetimePoints: 5_000, discountPercent: 10 },
];

/** Rupiah paid for each point earned. */
export const RUPIAH_PER_POINT = 1_000;

/** The tier held with this many lifetime points. */
export function tierFor(lifetimePoints: number): TierRule {
  return TIER_RULES.reduce<TierRule>(
    (held, rule) => (lifetimePoints >= rule.minLifetimePoints ? rule : held),
    TIER_RULES[0],
  );
}

/** The tier above `tier`, or `null` at the top. */
export function tierAbove(tier: LoyaltyTier): TierRule | null {
  const index = TIER_RULES.findIndex((rule) => rule.tier === tier);

  return index === -1 ? null : (TIER_RULES.at(index + 1) ?? null);
}

/** Points a payment of `amountPaid` rupiah earns: one per full Rp 1.000. */
export function pointsEarnedFor(amountPaid: number): number {
  return Math.floor(amountPaid / RUPIAH_PER_POINT);
}
