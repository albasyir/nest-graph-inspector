import type { VoucherDiscount, VoucherRow } from '../database/database.schema';

/**
 * Rupiah a voucher takes off a subtotal: a percentage rounded down and held
 * to its cap, or a fixed amount — never more than the subtotal itself.
 */
export function discountFor(
  discount: VoucherDiscount,
  subtotal: number,
): number {
  switch (discount.kind) {
    case 'PERCENTAGE': {
      const percentage = Math.floor((subtotal * discount.percent) / 100);
      const capped =
        discount.maxDiscount === null
          ? percentage
          : Math.min(percentage, discount.maxDiscount);

      return Math.min(capped, subtotal);
    }
    case 'FIXED':
      return Math.min(discount.amount, subtotal);
    default: {
      const _exhaustive: never = discount;

      return _exhaustive;
    }
  }
}

/** Whether a voucher has passed its expiry at `now`. */
export function hasExpired(
  voucher: Pick<VoucherRow, 'expiresAt'>,
  now: Date,
): boolean {
  return (
    voucher.expiresAt !== null && Date.parse(voucher.expiresAt) <= now.getTime()
  );
}
