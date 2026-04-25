import { Module } from '@nestjs/common';
import { ProductModule } from './product/product.module';
import { OrderModule } from './order/order.module';
import { NestGraphInspectorModule } from 'nest-graph-inspector/nest-graph-inspector';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    /**
     * Nest Graph Inspector
     */
    NestGraphInspectorModule,

    /**
     * Feature Modules
     */
    UserModule,
    ProductModule,
    OrderModule,
  ],
})
export class AppModule { }
