import { forwardRef, Module } from '@nestjs/common';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import { OrderModule } from '../order/order.module';

/**
 * Recommendations computed from paid orders; it stores nothing of its own.
 * Imports OrderModule through forwardRef(): Order reaches back here through
 * StoreProduct and Product, so this import closes the loop
 * Product → Recommendation → Order → StoreProduct → Product.
 */
@Module({
  imports: [forwardRef(() => OrderModule)],
  controllers: [RecommendationController],
  providers: [RecommendationService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
