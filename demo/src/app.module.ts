import { Module } from '@nestjs/common';

import { ProductModule } from './product/product.module';
import { OrderModule } from './order/order.module';
import { NestGraphInspectorModule } from 'nest-graph-inspector';
import { UserModule } from './user/user.module';
import {
  resolveInspectorAccessToken,
  resolveInspectorOutputs,
} from './inspector-outputs';

/**
 * This is playground root module
 * that imports the feature modules and the Nest Graph Inspector module.
 */
@Module({
  imports: [
    /**
     * Nest Graph Inspector
     *
     * The outputs depend on where this build runs: a developer machine writes
     * graph files to disk, the documentation site runs the same build in the
     * browser and only serves the viewer endpoint.
     */
    NestGraphInspectorModule.forRoot({
      outputs: resolveInspectorOutputs(),
      accessToken: resolveInspectorAccessToken(),
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
