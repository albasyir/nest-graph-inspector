import { Module } from '@nestjs/common';
import { NestGraphInspectorModule } from 'nest-graph-inspector';
/*
 * The order of these imports is load-bearing. ProductModule,
 * RecommendationModule, OrderModule and StoreProductModule import one another
 * in a loop — and so do their services — in which only two edges are
 * forwardRef(): Product → Recommendation and Recommendation → Order. A file
 * that is still loading exports nothing yet, so the loop has to be entered
 * at a file whose class only a forwardRef() reads early: OrderModule, loaded
 * here before the other three. Entered at ProductModule instead,
 * StoreProductModule would read ProductModule (and StoreProductService would
 * read ProductService) while still undefined, and Nest would refuse to start.
 */
import { AuthModule } from './auth/auth.module';
import { CustomerLoyaltyModule } from './customer-loyalty/customer-loyalty.module';
import { CustomerModule } from './customer/customer.module';
import { DatabaseModule } from './database/database.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { ProductModule } from './product/product.module';
import { RecommendationModule } from './recommendation/recommendation.module';
import { StoreProductModule } from './store-product/store-product.module';
import { StoreModule } from './store/store.module';
import { VoucherModule } from './voucher/voucher.module';

/**
 * The Shop App: a NestJS REST API for a small chain of stores — catalogue,
 * shelves, accounts, loyalty points, vouchers, checkout and payment — and
 * the Nest Graph Inspector watching it.
 *
 * It needs nothing else running: DatabaseModule keeps every table in memory,
 * seeded at start-up, and simulates a database round trip on every read and
 * write. Its module graph has two loops on purpose — Order ⇄ Payment, and
 * Product → Recommendation → Order → StoreProduct → Product — because a
 * graph tool needs something worth graphing.
 */
@Module({
  imports: [
    /**
     * Nest Graph Inspector
     */
    NestGraphInspectorModule.forRoot({
      outputs: [
        { type: 'viewer', host: 'localhost', port: 53371 },
        { type: 'markdown', path: 'tmp/graph/output.md' },
        { type: 'json', path: 'tmp/graph/output.json' },
        { type: 'http', host: 'localhost', port: 53372, path: 'graph' },
      ],
      ignore: {
        modules: ['InternalCoreModule'],
        providers: ['ModuleRef', 'ApplicationConfig', 'Reflector', 'noop'],
      },
    }),

    /**
     * Storage, global: every feature module injects it without importing it
     */
    DatabaseModule,

    /**
     * Feature Modules
     */
    AuthModule,
    CustomerModule,
    CustomerLoyaltyModule,
    OrderModule,
    PaymentModule,
    ProductModule,
    RecommendationModule,
    StoreModule,
    StoreProductModule,
    VoucherModule,
  ],
})
export class AppModule {}
