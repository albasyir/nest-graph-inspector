import type {
  LoyaltyAccountRow,
  LoyaltyTier,
} from '../database/database.schema';
import type { TierRule } from './loyalty-rules';

/** A customer's points, their tier, and how far the next tier is. */
export interface LoyaltyAccount extends Pick<
  LoyaltyAccountRow,
  'customerId' | 'pointsBalance' | 'lifetimePoints'
> {
  readonly tier: LoyaltyTier;
  readonly tierDiscountPercent: number;
  /** The next tier up and the lifetime points still needed; `null` at the top. */
  readonly nextTier: {
    readonly tier: LoyaltyTier;
    readonly lifetimePointsNeeded: number;
  } | null;
}

/** The discount a customer's tier gives at checkout. */
export interface TierDiscount {
  readonly tier: LoyaltyTier;
  readonly percent: number;
}

/** Points added to, or taken from, one customer's balance. */
export interface PointsChange {
  readonly customerId: string;
  /** A whole number of points, at least 1. */
  readonly points: number;
}

/** How the programme works, for anyone to read. */
export interface LoyaltyProgramme {
  readonly rupiahPerPoint: number;
  readonly tiers: readonly TierRule[];
}
