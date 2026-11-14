import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentCustomerId } from '../common/current-customer.decorator';
import {
  type CheckoutResult,
  type Order,
  parseCheckoutBody,
} from './order.dto';
import { OrderService } from './order.service';

/** The signed-in customer's orders: checkout, history and cancelling. */
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  /** `POST /orders/checkout` — check out a cart; answers with the order and its bill. */
  @Post('checkout')
  checkout(
    @CurrentCustomerId() customerId: string,
    @Body() body: unknown,
  ): Promise<CheckoutResult> {
    return this.orderService.checkout({
      customerId,
      ...parseCheckoutBody(body),
    });
  }

  /** `GET /orders` — the signed-in customer's orders, newest first. */
  @Get()
  listMyOrders(@CurrentCustomerId() customerId: string): Promise<Order[]> {
    return this.orderService.listOrdersForCustomer(customerId);
  }

  /** `GET /orders/:orderId` — one of the signed-in customer's orders. */
  @Get(':orderId')
  getMyOrder(
    @CurrentCustomerId() customerId: string,
    @Param('orderId') orderId: string,
  ): Promise<Order> {
    return this.orderService.getOrderForCustomer({ orderId, customerId });
  }

  /** `POST /orders/:orderId/cancel` — cancel an unpaid order. */
  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  cancelMyOrder(
    @CurrentCustomerId() customerId: string,
    @Param('orderId') orderId: string,
  ): Promise<Order> {
    return this.orderService.cancelOrderForCustomer({ orderId, customerId });
  }
}
