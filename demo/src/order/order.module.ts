import { forwardRef, Module } from '@nestjs/common';
// This module's own files load before the modules it imports, on purpose:
// OrderService is where the Product → Recommendation → Order → StoreProduct
// service loop must be entered (see app.module.ts).
import { OrderController } from './order.controller';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';
import { CustomerLoyaltyModule } from '../customer-loyalty/customer-loyalty.module';
import { PaymentModule } from '../payment/payment.module';
import { StoreProductModule } from '../store-product/store-product.module';
import { VoucherModule } from '../voucher/voucher.module';

/**
 * Orders and checkout. Imports StoreProductModule for prices and stock,
 * VoucherModule and CustomerLoyaltyModule for discounts and points, and
 * PaymentModule to bill the customer — through forwardRef(), because
 * PaymentModule imports this one back: a direct loop.
 */
@Module({
  imports: [
    StoreProductModule,
    VoucherModule,
    CustomerLoyaltyModule,
    forwardRef(() => PaymentModule),
  ],
  controllers: [OrderController],
  providers: [OrderRepository, OrderService],
  exports: [OrderService],
})
export class OrderModule {}
