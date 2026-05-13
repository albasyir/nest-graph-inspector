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
        { type: 'viewer', host: 'localhost', port: 33771 },
        { type: 'markdown', path: 'tmp/graph.md' },
        { type: 'json', path: 'tmp/graph.json' },
        { type: 'http', host: 'localhost', port: 3998, path: 'graph' },
      ]
    }),

    /**
     * Feature Modules
     */
    UserModule,
    ProductModule,
    OrderModule,
  ],
})
export class AppModule { }
