import {
  parseJsonObject,
  parseOptionalIntegerQuery,
  requireInteger,
} from '../common/request-parsing';
import type {
  ProductCategory,
  StoreProductRow,
} from '../database/database.schema';

/** A product on a store's shelf, with the store's price and stock. */
export interface StoreListing {
  readonly storeId: string;
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly category: ProductCategory;
  /** Price at this store, in rupiah. */
  readonly price: number;
  /** Units on the shelf that no order has reserved yet. */
  readonly stock: number;
}

/** One product at one store. */
export type ShelfItemRef = Pick<StoreProductRow, 'storeId' | 'productId'>;

/** A number of units of one product at one store. */
export interface StockRequest extends ShelfItemRef {
  readonly quantity: number;
}

/** Whether a store can supply a quantity right now. */
export interface StockCheck {
  readonly listing: StoreListing;
  readonly requested: number;
  readonly available: boolean;
}

/** Stock taken off or put back on a shelf. */
export interface StockMovement extends StockRequest {
  /** Units on the shelf afterwards. */
  readonly stockAfter: number;
}

/** A store's price and stock for one product. */
export type ListingTerms = Pick<StoreProductRow, 'price' | 'stock'>;

/** Puts a product on a store's shelf, or changes its price and stock there. */
export type ListingUpsert = ShelfItemRef & ListingTerms;

/** The most units one order line, or one stock movement, may move. */
export const MAX_QUANTITY = 99;

/** Reads `PUT /stores/:storeId/products/:productId`'s body. */
export function parseListingTerms(body: unknown): ListingTerms {
  const source = parseJsonObject(body);

  return {
    price: requireInteger(source, 'price', { min: 1, max: 100_000_000 }),
    stock: requireInteger(source, 'stock', { min: 0, max: 100_000 }),
  };
}

/** Reads the `?quantity=` of a stock check; 1 when left out. */
export function parseQuantityQuery(quantity: unknown): number {
  return (
    parseOptionalIntegerQuery(quantity, 'quantity', {
      min: 1,
      max: MAX_QUANTITY,
    }) ?? 1
  );
}
