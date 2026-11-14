import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  OrderRow,
  PaidOrderRow,
  PendingPaymentOrderRow,
} from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';

/** What it takes to record a checked-out order. */
export type NewPendingOrder = Omit<
  PendingPaymentOrderRow,
  'id' | 'createdAt' | 'updatedAt' | 'status'
>;

/** Reads and writes the orders table. */
@Injectable()
export class OrderRepository {
  private readonly orders: InMemoryTable<OrderRow>;

  constructor(database: DatabaseService) {
    this.orders = database.orders;
  }

  findById(orderId: string): Promise<OrderRow | null> {
    return this.orders.findById(orderId);
  }

  /** A customer's orders, oldest first. */
  listByCustomer(customerId: string): Promise<OrderRow[]> {
    return this.orders.findMany((order) => order.customerId === customerId);
  }

  /** Paid orders that held this product, oldest first. */
  listPaidContaining(productId: string): Promise<PaidOrderRow[]> {
    return this.orders.findMany(
      (order): order is PaidOrderRow =>
        order.status === 'PAID' &&
        order.lines.some((line) => line.productId === productId),
    );
  }

  insertPending(order: NewPendingOrder): Promise<PendingPaymentOrderRow> {
    return this.orders.insert((metadata): PendingPaymentOrderRow => ({
      ...metadata,
      ...order,
      status: 'PENDING_PAYMENT',
    }));
  }

  /**
   * Moves an order to the state `change` returns, checked and written in one
   * step.
   *
   * @throws NotFoundException when there is no such order
   */
  async transition<N extends OrderRow>(
    orderId: string,
    change: (current: OrderRow) => N,
  ): Promise<N> {
    const order = await this.orders.update(orderId, change);

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    return order;
  }
}
