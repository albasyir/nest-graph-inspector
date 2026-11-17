import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { orConflict } from '../common/conflict';
import type { UnpaidBillRow, VoidBillRow } from '../database/database.schema';
import { OrderService } from '../order/order.service';
import {
  assertUnpaid,
  toFailedBill,
  toPaidBill,
  toVoidBill,
} from './payment-state';
import type {
  Bill,
  BillSettlement,
  CustomerBillRef,
  GatewayCallback,
  NewBill,
  SimulatedFailure,
} from './payment.dto';
import { PaymentRepository } from './payment.repository';

/** How a bill is being settled. */
type Settlement =
  | { readonly status: 'PAID' }
  | { readonly status: 'FAILED'; readonly failureReason: string };

/**
 * Bills, and the payment gateway — simulated: no money moves anywhere.
 *
 * Checkout asks for a bill. The customer then "pays" it through the
 * simulation, or the gateway calls back, and the outcome goes to
 * OrderService: a payment marks the order paid, a failure cancels it. A
 * bill's unguessable gateway reference stands in for the signature a real
 * gateway would put on its callback.
 *
 * OrderService is injected through forwardRef(): it bills through this
 * service, so the two modules import each other.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly bills: PaymentRepository,
    @Inject(forwardRef(() => OrderService))
    private readonly orders: OrderService,
  ) {}

  /**
   * Raises an UNPAID bill for an order, with a fresh gateway reference.
   *
   * @throws BadRequestException when the amount is not a whole, non-negative rupiah amount
   * @throws ConflictException when the order already has a bill
   */
  createBill(bill: NewBill): Promise<UnpaidBillRow> {
    if (!Number.isInteger(bill.amount) || bill.amount < 0) {
      throw new BadRequestException(
        'amount must be a whole number of rupiah, not negative',
      );
    }

    return orConflict(
      this.bills.insertUnpaid({
        ...bill,
        gatewayReference: `pg_${randomBytes(18).toString('base64url')}`,
      }),
      `Order ${bill.orderId} already has a bill`,
    );
  }

  /**
   * One of a customer's bills. Another customer's bill is reported as not
   * found rather than forbidden, so ids reveal nothing.
   *
   * @throws NotFoundException when the customer has no such bill
   */
  async getBillForCustomer(ref: CustomerBillRef): Promise<Bill> {
    const bill = await this.bills.findById(ref.billId);

    if (!bill || bill.customerId !== ref.customerId) {
      throw new NotFoundException(`Bill ${ref.billId} not found`);
    }

    return bill;
  }

  /**
   * Simulates the customer paying their bill at the gateway, which then
   * reports success: the bill is PAID and the order with it.
   *
   * @throws NotFoundException when the customer has no such bill
   * @throws ConflictException when the bill is already settled
   */
  async simulatePayment(ref: CustomerBillRef): Promise<BillSettlement> {
    const bill = await this.getBillForCustomer(ref);

    return this.settle(bill, { status: 'PAID' });
  }

  /**
   * Simulates the gateway declining the payment: the bill FAILS and the
   * order is cancelled, its stock put back.
   *
   * @throws NotFoundException when the customer has no such bill
   * @throws ConflictException when the bill is already settled
   */
  async simulateFailure(failure: SimulatedFailure): Promise<BillSettlement> {
    const bill = await this.getBillForCustomer(failure);

    return this.settle(bill, {
      status: 'FAILED',
      failureReason: failure.reason ?? 'Payment declined (simulated)',
    });
  }

  /**
   * The gateway's server-to-server report on a payment.
   *
   * @throws NotFoundException when no bill has this gateway reference
   * @throws ConflictException when the bill is already settled
   */
  async handleGatewayCallback(
    callback: GatewayCallback,
  ): Promise<BillSettlement> {
    const bill = await this.bills.findByGatewayReference(
      callback.gatewayReference,
    );

    if (!bill) {
      throw new NotFoundException('No bill has this gateway reference');
    }

    return this.settle(
      bill,
      callback.status === 'PAID'
        ? { status: 'PAID' }
        : {
            status: 'FAILED',
            failureReason:
              callback.failureReason ?? 'The gateway reported a failed payment',
          },
    );
  }

  /**
   * Withdraws the unpaid bill of an order that was called off.
   *
   * @throws NotFoundException when the order has no bill
   * @throws ConflictException when the bill is already settled
   */
  async voidBillForOrder(orderId: string): Promise<VoidBillRow> {
    const bill = await this.bills.findByOrderId(orderId);

    if (!bill) {
      throw new NotFoundException(`Order ${orderId} has no bill`);
    }

    return this.bills.transition(bill.id, (current) =>
      toVoidBill(current, new Date().toISOString()),
    );
  }

  /**
   * Settles a bill. The order goes first: if it cannot be paid or
   * cancelled, the bill stays UNPAID and the error says why.
   */
  private async settle(
    bill: Bill,
    settlement: Settlement,
  ): Promise<BillSettlement> {
    assertUnpaid(bill);

    switch (settlement.status) {
      case 'PAID': {
        const order = await this.orders.markPaid(bill.orderId);
        const paid = await this.bills.transition(bill.id, (current) =>
          toPaidBill(current, new Date().toISOString()),
        );

        return { bill: paid, order };
      }
      case 'FAILED': {
        const order = await this.orders.cancelOrder({
          orderId: bill.orderId,
          reason: `Payment failed: ${settlement.failureReason}`,
        });
        const failed = await this.bills.transition(bill.id, (current) =>
          toFailedBill(current, {
            failedAt: new Date().toISOString(),
            failureReason: settlement.failureReason,
          }),
        );

        return { bill: failed, order };
      }
      default: {
        const _exhaustive: never = settlement;

        return _exhaustive;
      }
    }
  }
}
