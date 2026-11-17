import { Injectable } from '@nestjs/common';
import type { StoreProductRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { ListingUpsert, ShelfItemRef } from './store-product.dto';

/** Reads and writes the store_products table: what each shelf holds. */
@Injectable()
export class StoreProductRepository {
  private readonly listings: InMemoryTable<StoreProductRow>;

  constructor(database: DatabaseService) {
    this.listings = database.storeProducts;
  }

  findListing({
    storeId,
    productId,
  }: ShelfItemRef): Promise<StoreProductRow | null> {
    return this.listings.findOne(
      (listing) =>
        listing.storeId === storeId && listing.productId === productId,
    );
  }

  listByStore(storeId: string): Promise<StoreProductRow[]> {
    return this.listings.findMany((listing) => listing.storeId === storeId);
  }

  /** @throws UniqueConstraintViolationError when the store already lists it */
  insert(listing: ListingUpsert): Promise<StoreProductRow> {
    return this.listings.insert((metadata) => ({ ...metadata, ...listing }));
  }

  /** Replaces a listing with what `change` makes of it; `null` when there is none. */
  update<N extends StoreProductRow>(
    listingId: string,
    change: (current: StoreProductRow) => N,
  ): Promise<N | null> {
    return this.listings.update(listingId, change);
  }
}
