import type { OrderLine, OrderPricing } from '../database/database.schema';

/** An order line, priced at the shelf price. */
export function priceLine(line: Omit<OrderLine, 'lineTotal'>): OrderLine {
  return { ...line, lineTotal: line.unitPrice * line.quantity };
}

/** What the lines add up to before any discount. */
export function subtotalOf(lines: readonly OrderLine[]): number {
  return lines.reduce((sum, line) => sum + line.lineTotal, 0);
}

/**
 * How checkout reaches a total: the voucher comes off the subtotal first,
 * then the tier discount off what is left, rounded down to a whole rupiah.
 * Neither can take the total below zero.
 */
export function priceOrder(input: {
  readonly subtotal: number;
  readonly voucherDiscount: number;
  readonly tierDiscountPercent: number;
}): OrderPricing {
  const voucherDiscount = Math.min(input.voucherDiscount, input.subtotal);
  const afterVoucher = input.subtotal - voucherDiscount;
  const tierDiscount = Math.floor(
    (afterVoucher * input.tierDiscountPercent) / 100,
  );

  return {
    subtotal: input.subtotal,
    voucherDiscount,
    tierDiscount,
    total: afterVoucher - tierDiscount,
  };
}
