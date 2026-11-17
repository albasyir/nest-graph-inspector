import {
  optionalText,
  parseJsonObject,
  requireOneOf,
  requireText,
} from '../common/request-parsing';
import type { BillRow, OrderRow } from '../database/database.schema';

/** A bill, in whichever state it is in. */
export type Bill = BillRow;

/** What it takes to raise a bill. */
export type NewBill = Pick<BillRow, 'orderId' | 'customerId' | 'amount'>;

export const PAYMENT_OUTCOMES = ['PAID', 'FAILED'] as const;

/** What the gateway reports happened to a payment. */
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

/** The payment gateway telling the shop how a bill's payment went. */
export interface GatewayCallback {
  /** The reference the bill was raised with. */
  readonly gatewayReference: string;
  readonly status: PaymentOutcome;
  /** Why the payment failed, when it did. */
  readonly failureReason?: string;
}

/** A bill looked up for the customer it was raised for. */
export interface CustomerBillRef {
  readonly billId: string;
  readonly customerId: string;
}

/** A simulated failed payment, with the reason the "gateway" gives. */
export interface SimulatedFailure extends CustomerBillRef {
  readonly reason?: string;
}

/** A settled bill and the order it settled. */
export interface BillSettlement {
  readonly bill: Bill;
  readonly order: OrderRow;
}

/** Reads `POST /payments/callback`'s body. */
export function parseGatewayCallback(body: unknown): GatewayCallback {
  const source = parseJsonObject(body);
  const failureReason = optionalText(source, 'failureReason', {
    maxLength: 200,
  });

  return {
    gatewayReference: requireText(source, 'gatewayReference', {
      maxLength: 100,
    }),
    status: requireOneOf(source, 'status', PAYMENT_OUTCOMES),
    ...(failureReason === undefined ? {} : { failureReason }),
  };
}

/** Reads `POST /payments/bills/:billId/simulate-fail`'s optional body. */
export function parseSimulatedFailureBody(body: unknown): {
  readonly reason?: string;
} {
  if (body === undefined) {
    return {};
  }

  const reason = optionalText(parseJsonObject(body), 'reason', {
    maxLength: 200,
  });

  return reason === undefined ? {} : { reason };
}
