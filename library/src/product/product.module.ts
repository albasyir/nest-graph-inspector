import { forwardRef, Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ProductRepository } from './product.repository';
import { UserModule } from '../user/user.module';
import { MobileModule } from '../mobile/mobile.module';

/**
 * ProductModule imports UserModule but does NOT use any of its providers.
 * This is an intentionally useless import to test graph-inspector detection.
 */
@Module({
  imports: [forwardRef(() => UserModule), forwardRef(() => MobileModule)],
  controllers: [ProductController],
  providers: [ProductService, ProductRepository],
  exports: [ProductService],
})
export class ProductModule {}
