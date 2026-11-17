import { forwardRef, Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { OrderModule } from '../order/order.module';

/**
 * Bills and the simulated payment gateway. Imports OrderModule through
 * forwardRef(): OrderModule imports this one too — Order bills through
 * Payment, and Payment reports back to Order — a direct loop.
 */
@Module({
  imports: [forwardRef(() => OrderModule)],
  controllers: [PaymentController],
  providers: [PaymentRepository, PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
