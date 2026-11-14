import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { OrderService } from '../order/order.service';
import { rankFrequentlyBoughtTogether } from './frequently-bought-together';
import {
  DEFAULT_RECOMMENDATION_LIMIT,
  type FrequentlyBoughtTogether,
  type FrequentlyBoughtTogetherQuery,
} from './recommendation.dto';

/**
 * "Frequently bought together": for a product, the other products that most
 * often shared a paid order with it.
 *
 * Worked out on request from the paid orders OrderService hands over, so it
 * is never stale. Injecting OrderService closes a loop back to ProductModule
 * (Product → Recommendation → Order → StoreProduct → Product), hence the
 * forwardRef().
 */
@Injectable()
export class RecommendationService {
  constructor(
    @Inject(forwardRef(() => OrderService))
    private readonly orders: OrderService,
  ) {}

  /** The products most often in the same paid order as `query.productId`. */
  async frequentlyBoughtTogether(
    query: FrequentlyBoughtTogetherQuery,
  ): Promise<FrequentlyBoughtTogether[]> {
    const baskets = await this.orders.listPaidBasketsContaining(
      query.productId,
    );

    return rankFrequentlyBoughtTogether({
      baskets,
      productId: query.productId,
      limit: query.limit ?? DEFAULT_RECOMMENDATION_LIMIT,
    });
  }
}
