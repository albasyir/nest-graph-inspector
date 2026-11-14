import { forwardRef, Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';
import { RecommendationModule } from '../recommendation/recommendation.module';

/**
 * The product catalogue. Imports RecommendationModule for "frequently bought
 * together" — through forwardRef(), because that import closes a loop:
 * Product → Recommendation → Order → StoreProduct → Product.
 */
@Module({
  imports: [forwardRef(() => RecommendationModule)],
  controllers: [ProductController],
  providers: [ProductRepository, ProductService],
  exports: [ProductService],
})
export class ProductModule {}
