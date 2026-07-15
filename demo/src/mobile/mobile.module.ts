import { forwardRef, Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { MobileService } from './mobile.service';

@Module({
  imports: [forwardRef(() => ProductModule)],
  providers: [MobileService],
  exports: [MobileService],
})
export class MobileModule {}
