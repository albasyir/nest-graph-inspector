import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderNotificationService } from './order-notification.service';
import { ModuleRef } from '@nestjs/core';

@Controller('orders')
export class OrderController {
  /**
   * Property injection using @Inject() decorator
   */
  @Inject(OrderNotificationService)
  private readonly notificationService: OrderNotificationService;

  constructor(
    private readonly orderService: OrderService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Post()
  createOrder(@Body() body: { userId: number; productId: number; quantity: number }) {
    return this.orderService.createOrder(body.userId, body.productId, body.quantity);
  }

  @Get()
  getAllOrders() {
    return this.orderService.getAllOrders();
  }

  @Get(':id')
  getOrderById(@Param('id') id: string) {
    return this.orderService.getOrderById(Number(id));
  }

  @Get(':id/confirm')
  confirmOrder(@Param('id') id: string) {
    const order = this.orderService.confirmOrder(Number(id));
    if (order) {
      this.notificationService.notifyOrderShipped(order.id);
    }
    return order;
  }
}
