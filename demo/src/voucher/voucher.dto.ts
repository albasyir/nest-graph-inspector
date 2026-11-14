import {
  parseJsonObject,
  requireInteger,
  requireText,
} from '../common/request-parsing';
import type {
  RewardRow,
  VoucherRedemptionRow,
  VoucherRow,
} from '../database/database.schema';

/** A public voucher, as anyone browsing the shop sees it. */
export type PublicVoucher = Pick<
  VoucherRow,
  'code' | 'title' | 'discount' | 'minSpend' | 'expiresAt'
>;

/** A loyalty reward on offer. */
export type Reward = RewardRow;

/** Whether a customer can still use a voucher. */
export type VoucherUsage =
  | { readonly status: 'AVAILABLE' }
  | {
      readonly status: 'USED';
      readonly orderId: string;
      readonly usedAt: string;
    }
  | { readonly status: 'EXPIRED' };

/** A voucher a customer can see in their wallet. */
export interface CustomerVoucher extends PublicVoucher {
  readonly voucherId: string;
  readonly audience: VoucherRow['audience']['kind'];
  readonly usage: VoucherUsage;
}

/** Can this customer use this code on this subtotal, and for how much? */
export interface VoucherQuoteRequest {
  readonly code: string;
  readonly customerId: string;
  /** The order's subtotal in rupiah, before any discount. */
  readonly subtotal: number;
}

/** A voucher checked for one customer and subtotal. */
export interface VoucherQuote {
  readonly voucherId: string;
  readonly code: string;
  readonly title: string;
  /** Rupiah off the subtotal. */
  readonly discountAmount: number;
}

/** A voucher spent on a paid order. */
export type VoucherRedemption = Pick<
  VoucherRedemptionRow,
  'voucherId' | 'customerId' | 'orderId'
>;

/** A customer buying a reward voucher with points. */
export interface RewardClaim {
  readonly customerId: string;
  readonly rewardId: string;
}

/** What claiming a reward gave, and what it cost. */
export interface ClaimedReward {
  readonly voucher: CustomerVoucher;
  readonly pointsSpent: number;
  readonly pointsBalance: number;
}

/** What it takes to issue a voucher. */
export type NewVoucher = Pick<
  VoucherRow,
  'code' | 'title' | 'discount' | 'minSpend' | 'expiresAt' | 'audience'
>;

/** Codes are stored upper-case; customers may type them any way. */
export function normalizeVoucherCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Reads `POST /vouchers/quote`'s body. */
export function parseVoucherQuoteBody(
  body: unknown,
): Pick<VoucherQuoteRequest, 'code' | 'subtotal'> {
  const source = parseJsonObject(body);

  return {
    code: requireText(source, 'code', { maxLength: 40 }),
    subtotal: requireInteger(source, 'subtotal', {
      min: 0,
      max: 1_000_000_000,
    }),
  };
}
