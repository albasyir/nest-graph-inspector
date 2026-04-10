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
        { type: 'markdown', path: 'src/graph-output.md' },
        { type: 'json', path: 'src/graph-output.json' },
        { type: 'http', path: '/__graph-inspector' },
      ],
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
