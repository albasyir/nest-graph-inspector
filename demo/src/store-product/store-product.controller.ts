import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import {
  parseListingTerms,
  parseQuantityQuery,
  type StockCheck,
  type StoreListing,
} from './store-product.dto';
import { StoreProductService } from './store-product.service';

/**
 * A store's shelves. Anyone may see what a store sells and whether it has
 * stock; setting price and stock takes a signed-in account. Reserving and
 * releasing stock has no route: only checkout and cancellation do that.
 */
@Controller('stores/:storeId/products')
export class StoreProductController {
  constructor(private readonly storeProductService: StoreProductService) {}

  /** `GET /stores/:storeId/products` — everything the store sells. */
  @Public()
  @Get()
  listStoreProducts(
    @Param('storeId') storeId: string,
  ): Promise<StoreListing[]> {
    return this.storeProductService.listStoreProducts(storeId);
  }

  /** `GET /stores/:storeId/products/:productId` — one product's price and stock. */
  @Public()
  @Get(':productId')
  getListing(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
  ): Promise<StoreListing> {
    return this.storeProductService.getListing({ storeId, productId });
  }

  /** `GET /stores/:storeId/products/:productId/stock?quantity=` — enough on the shelf? */
  @Public()
  @Get(':productId/stock')
  checkStock(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
    @Query('quantity') quantity: unknown,
  ): Promise<StockCheck> {
    return this.storeProductService.checkStock({
      storeId,
      productId,
      quantity: parseQuantityQuery(quantity),
    });
  }

  /** `PUT /stores/:storeId/products/:productId` — set the price and stock. */
  @Put(':productId')
  upsertListing(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<StoreListing> {
    return this.storeProductService.upsertListing({
      storeId,
      productId,
      ...parseListingTerms(body),
    });
  }
}
