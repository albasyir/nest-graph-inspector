import { Injectable, NotFoundException } from '@nestjs/common';
import type { BillRow, UnpaidBillRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { NewBill } from './payment.dto';

/** Reads and writes the bills table. */
@Injectable()
export class PaymentRepository {
  private readonly bills: InMemoryTable<BillRow>;

  constructor(database: DatabaseService) {
    this.bills = database.bills;
  }

  findById(billId: string): Promise<BillRow | null> {
    return this.bills.findById(billId);
  }

  findByGatewayReference(gatewayReference: string): Promise<BillRow | null> {
    return this.bills.findOne(
      (bill) => bill.gatewayReference === gatewayReference,
    );
  }

  findByOrderId(orderId: string): Promise<BillRow | null> {
    return this.bills.findOne((bill) => bill.orderId === orderId);
  }

  /** @throws UniqueConstraintViolationError when the order already has a bill */
  insertUnpaid(
    bill: NewBill & Pick<BillRow, 'gatewayReference'>,
  ): Promise<UnpaidBillRow> {
    return this.bills.insert((metadata): UnpaidBillRow => ({
      ...metadata,
      ...bill,
      status: 'UNPAID',
    }));
  }

  /**
   * Moves a bill to the state `change` returns, checked and written in one
   * step.
   *
   * @throws NotFoundException when there is no such bill
   */
  async transition<N extends BillRow>(
    billId: string,
    change: (current: BillRow) => N,
  ): Promise<N> {
    const bill = await this.bills.update(billId, change);

    if (!bill) {
      throw new NotFoundException(`Bill ${billId} not found`);
    }

    return bill;
  }
}
