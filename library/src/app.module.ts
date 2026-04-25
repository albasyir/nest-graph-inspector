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
          { type: 'viewer', origin: 'http://localhost:9999' },
          { type: 'markdown', path: 'graph.md' },
          { type: 'json', path: 'graph.json' },
          { type: 'http', path: 'graph' },
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
