import { Module } from '@nestjs/common';
import { ProductModule } from './product/product.module';
import { OrderModule } from './order/order.module';
import { NestGraphInspectorModule } from 'nest-graph-inspector';
import { UserModule } from './user/user.module';

/**
 * This is playground root module 
 * that imports the feature modules and the Nest Graph Inspector module.
 */
@Module({
  imports: [
    /**
     * Nest Graph Inspector
     */
    NestGraphInspectorModule.forRoot({
      outputs: [
        { type: 'viewer', host: 'localhost', port: 53371 },
        { type: 'markdown', path: '../site/public/mock-graph/output.md' },
        { type: 'json', path: '../site/public/mock-graph/output.json' },
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
