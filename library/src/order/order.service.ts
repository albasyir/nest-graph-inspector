import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderRepository, Order } from './order.repository';
import { UserService } from '../user/user.service';
import { ProductService } from '../product/product.service';
import { OrderNotificationService } from './order-notification.service';

@Injectable()
export class OrderService {
  /**
   * Property injection using @Inject() with forwardRef
   * to break the circular dependency with OrderNotificationService
   */
  @Inject(forwardRef(() => OrderNotificationService))
  private readonly notificationService: OrderNotificationService;

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly userService: UserService,
    private readonly productService: ProductService,
  ) {}

  createOrder(userId: number, productId: number, quantity: number): Order | { error: string } {
    const user = this.userService.getUserById(userId);
    if (!user) {
      return { error: `User #${userId} not found` };
    }

    const product = this.productService.getProductById(productId);
    if (!product) {
      return { error: `Product #${productId} not found` };
    }

    const order = this.orderRepository.create(userId, productId, quantity);
    this.notificationService.notifyOrderCreated(order);
    return order;
  }

  getOrderById(id: number): Order | undefined {
    return this.orderRepository.findById(id);
  }

  getAllOrders(): Order[] {
    return this.orderRepository.findAll();
  }

  getOrdersByUser(userId: number): Order[] {
    return this.orderRepository.findByUserId(userId);
  }

  confirmOrder(id: number): Order | undefined {
    return this.orderRepository.updateStatus(id, 'confirmed');
  }
}
