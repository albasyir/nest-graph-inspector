import {
  optionalText,
  parseJsonObject,
  requireArray,
  requireInteger,
  requireText,
} from '../common/request-parsing';
import type {
  OrderLine,
  OrderRow,
  PendingPaymentOrderRow,
} from '../database/database.schema';
import type { Bill } from '../payment/payment.dto';
import { MAX_QUANTITY } from '../store-product/store-product.dto';

/** An order, in whichever state it is in. */
export type Order = OrderRow;

/** One product and how many of it, as a customer puts it in the cart. */
export interface CheckoutItem {
  readonly productId: string;
  readonly quantity: number;
}

/** A cart to check out at one store. */
export interface CheckoutRequest {
  readonly customerId: string;
  readonly storeId: string;
  /** One entry per product, at least one and at most 20. */
  readonly items: readonly CheckoutItem[];
  /** A voucher code to apply, if any. */
  readonly voucherCode?: string;
}

/** A checked-out order and the bill that collects for it. */
export interface CheckoutResult {
  readonly order: PendingPaymentOrderRow;
  readonly bill: Bill;
}

/** An order to cancel, and why. */
export interface OrderCancellation {
  readonly orderId: string;
  readonly reason: string;
}

/** An order looked up for the customer who placed it. */
export interface CustomerOrderRef {
  readonly orderId: string;
  readonly customerId: string;
}

/** What one paid order held — the co-purchase data recommendations read. */
export interface PurchasedBasket {
  readonly orderId: string;
  readonly lines: readonly Pick<OrderLine, 'productId' | 'productName'>[];
}

/** The most different products one order may hold. */
export const MAX_CHECKOUT_ITEMS = 20;

/** Reads `POST /orders/checkout`'s body. */
export function parseCheckoutBody(
  body: unknown,
): Omit<CheckoutRequest, 'customerId'> {
  const source = parseJsonObject(body);
  const items = requireArray(source, 'items', {
    minLength: 1,
    maxLength: MAX_CHECKOUT_ITEMS,
  }).map((item, index): CheckoutItem => {
    const label = `items[${index}]`;
    const entry = parseJsonObject(item, label);

    return {
      productId: requireText(entry, 'productId', {
        label: `${label}.productId`,
        maxLength: 40,
      }),
      quantity: requireInteger(entry, 'quantity', {
        label: `${label}.quantity`,
        min: 1,
        max: MAX_QUANTITY,
      }),
    };
  });
  const voucherCode = optionalText(source, 'voucherCode', { maxLength: 40 });

  return {
    storeId: requireText(source, 'storeId', { maxLength: 40 }),
    items,
    ...(voucherCode === undefined ? {} : { voucherCode }),
  };
}
