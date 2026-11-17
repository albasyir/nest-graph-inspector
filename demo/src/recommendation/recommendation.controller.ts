import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import { parseOptionalIntegerQuery } from '../common/request-parsing';
import {
  type FrequentlyBoughtTogether,
  MAX_RECOMMENDATION_LIMIT,
} from './recommendation.dto';
import { RecommendationService } from './recommendation.service';

/** Recommendations drawn from what customers actually bought. Public. */
@Controller('recommendations')
export class RecommendationController {
  constructor(private readonly recommendationService: RecommendationService) {}

  /** `GET /recommendations/frequently-bought-together/:productId?limit=` */
  @Public()
  @Get('frequently-bought-together/:productId')
  frequentlyBoughtTogether(
    @Param('productId') productId: string,
    @Query('limit') limit: unknown,
  ): Promise<FrequentlyBoughtTogether[]> {
    return this.recommendationService.frequentlyBoughtTogether({
      productId,
      limit: parseOptionalIntegerQuery(limit, 'limit', {
        min: 1,
        max: MAX_RECOMMENDATION_LIMIT,
      }),
    });
  }
}
