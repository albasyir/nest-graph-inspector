import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProductModule } from '../product/product.module';
import { MobileService } from './mobile.service';

@Module({
  imports: [ConfigModule.forRoot(), forwardRef(() => ProductModule)],
  providers: [MobileService],
  exports: [MobileService],
})
export class MobileModule {}
