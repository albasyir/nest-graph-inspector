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
    NestGraphInspectorModule.forRoot({
      outputs: [
        { type: 'viewer', host: 'localhost', port: 53371 },
        { type: 'markdown', path: 'tmp/graph/output.md' },
        { type: 'json', path: 'tmp/graph/output.json' },
        { type: 'http', host: 'localhost', port: 53372, path: 'graph' },
      ],
    }),

    // NestGraphInspectorModule,

    /**
     * Feature Modules
     */
    UserModule,
    ProductModule,
    OrderModule,
  ],
})
export class AppModule {}
