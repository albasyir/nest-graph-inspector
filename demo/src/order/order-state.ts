import { ConflictException } from '@nestjs/common';
import type {
  CancelledOrderRow,
  OrderRow,
  PaidOrderRow,
  PendingPaymentOrderRow,
} from '../database/database.schema';

/**
 * An order's life: PENDING_PAYMENT, then PAID or CANCELLED, and never
 * anything after that. Both moves start from PENDING_PAYMENT; anything else
 * is refused with a 409.
 */

/** Refuses an order that is not waiting for payment. */
export function assertPendingPayment(
  order: OrderRow,
  action: 'paid' | 'cancelled',
): asserts order is PendingPaymentOrderRow {
  if (order.status !== 'PENDING_PAYMENT') {
    throw new ConflictException(
      `Order ${order.id} is ${order.status}; only an order waiting for payment can be ${action}`,
    );
  }
}

/** PENDING_PAYMENT → PAID. */
export function toPaid(
  order: OrderRow,
  payment: Pick<PaidOrderRow, 'paidAt' | 'pointsEarned'>,
): PaidOrderRow {
  assertPendingPayment(order, 'paid');

  return {
    ...order,
    status: 'PAID',
    paidAt: payment.paidAt,
    pointsEarned: payment.pointsEarned,
  };
}

/** PENDING_PAYMENT → CANCELLED. */
export function toCancelled(
  order: OrderRow,
  cancellation: Pick<CancelledOrderRow, 'cancelledAt' | 'cancelReason'>,
): CancelledOrderRow {
  assertPendingPayment(order, 'cancelled');

  return {
    ...order,
    status: 'CANCELLED',
    cancelledAt: cancellation.cancelledAt,
    cancelReason: cancellation.cancelReason,
  };
}
