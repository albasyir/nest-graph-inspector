import { Module } from '@nestjs/common';
import { StoreProductController } from './store-product.controller';
import { StoreProductRepository } from './store-product.repository';
import { StoreProductService } from './store-product.service';
import { ProductModule } from '../product/product.module';
import { StoreModule } from '../store/store.module';

/**
 * Store shelves: what each store sells, at what price, with how much stock.
 * Imports ProductModule and StoreModule. The ProductModule import is the one
 * edge of the Product → Recommendation → Order → StoreProduct → Product loop
 * that is a plain import.
 */
@Module({
  imports: [ProductModule, StoreModule],
  controllers: [StoreProductController],
  providers: [StoreProductRepository, StoreProductService],
  exports: [StoreProductService],
})
export class StoreProductModule {}
