import { ConflictException } from '@nestjs/common';
import type {
  BillRow,
  FailedBillRow,
  PaidBillRow,
  UnpaidBillRow,
  VoidBillRow,
} from '../database/database.schema';

/**
 * A bill's life: UNPAID, then exactly one of PAID, FAILED or VOID. Every
 * move starts from UNPAID; anything else is refused with a 409, so a bill can
 * never be settled twice.
 */

/** Refuses a bill that has already been settled. */
export function assertUnpaid(bill: BillRow): asserts bill is UnpaidBillRow {
  if (bill.status !== 'UNPAID') {
    throw new ConflictException(`Bill ${bill.id} is already ${bill.status}`);
  }
}

/** UNPAID → PAID. */
export function toPaidBill(bill: BillRow, paidAt: string): PaidBillRow {
  assertUnpaid(bill);

  return { ...bill, status: 'PAID', paidAt };
}

/** UNPAID → FAILED. */
export function toFailedBill(
  bill: BillRow,
  failure: Pick<FailedBillRow, 'failedAt' | 'failureReason'>,
): FailedBillRow {
  assertUnpaid(bill);

  return {
    ...bill,
    status: 'FAILED',
    failedAt: failure.failedAt,
    failureReason: failure.failureReason,
  };
}

/** UNPAID → VOID. */
export function toVoidBill(bill: BillRow, voidedAt: string): VoidBillRow {
  assertUnpaid(bill);

  return { ...bill, status: 'VOID', voidedAt };
}
