import { forwardRef, Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { OrderNotificationService } from './order-notification.service';
import { UserModule } from '../user/user.module';
import { ProductModule } from '../product/product.module';

@Module({
  imports: [
    /**
     * Using forwardRef on module import to demonstrate
     * module-level circular dependency resolution
     */
    forwardRef(() => UserModule),
    ProductModule,
  ],
  controllers: [OrderController],
  providers: [
    OrderRepository,
    OrderService,
    OrderNotificationService,
  ],
  exports: [OrderService],
})
export class OrderModule {}
