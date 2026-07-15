import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order } from './order.repository';

/**
 * OrderNotificationService has a circular dependency with OrderService.
 * Uses forwardRef in constructor @Inject() to resolve it.
 */
@Injectable()
export class OrderNotificationService {
  constructor(
    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,
  ) {}

  notifyOrderCreated(order: Order): void {
    console.log(`[Notification] Order #${order.id} created for user #${order.userId}`);
  }

  notifyOrderShipped(orderId: number): void {
    const order = this.orderService.getOrderById(orderId);
    if (order) {
      console.log(`[Notification] Order #${order.id} has been shipped`);
    }
  }
}
