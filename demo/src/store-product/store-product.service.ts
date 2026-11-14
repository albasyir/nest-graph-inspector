import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { orConflict } from '../common/conflict';
import type { ProductRow, StoreProductRow } from '../database/database.schema';
import { ProductService } from '../product/product.service';
import { StoreService } from '../store/store.service';
import {
  type ListingUpsert,
  MAX_QUANTITY,
  type ShelfItemRef,
  type StockCheck,
  type StockMovement,
  type StockRequest,
  type StoreListing,
} from './store-product.dto';
import { StoreProductRepository } from './store-product.repository';

/**
 * What each store sells, at what price, and how many are on the shelf.
 *
 * Checkout checks stock and reserves it here, and a cancelled order puts it
 * back. A reservation is a conditional decrement — the check and the write
 * happen in one step — so two checkouts can never both take the last unit.
 */
@Injectable()
export class StoreProductService {
  constructor(
    private readonly listings: StoreProductRepository,
    private readonly products: ProductService,
    private readonly stores: StoreService,
  ) {}

  /**
   * Everything an open store sells, with its price and stock there.
   *
   * @throws NotFoundException when there is no such store
   * @throws ConflictException when the store is closed
   */
  async listStoreProducts(storeId: string): Promise<StoreListing[]> {
    await this.stores.getOpenStore(storeId);

    const rows = await this.listings.listByStore(storeId);
    const products = await this.products.findProducts(
      rows.map((row) => row.productId),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    return rows.flatMap((row) => {
      const product = byId.get(row.productId);

      return product ? [toStoreListing(row, product)] : [];
    });
  }

  /**
   * One product on one open store's shelf.
   *
   * @throws NotFoundException when the store or product does not exist, or
   * the store does not sell the product
   * @throws ConflictException when the store is closed
   */
  async getListing({
    storeId,
    productId,
  }: ShelfItemRef): Promise<StoreListing> {
    await this.stores.getOpenStore(storeId);

    const [product, row] = await Promise.all([
      this.products.getProduct(productId),
      this.listings.findListing({ storeId, productId }),
    ]);

    if (!row) {
      throw notSoldHere({ storeId, productId });
    }

    return toStoreListing(row, product);
  }

  /** Whether a store has `quantity` units of a product on its shelf. */
  async checkStock(request: StockRequest): Promise<StockCheck> {
    const listing = await this.getListing(request);

    return {
      listing,
      requested: request.quantity,
      available: listing.stock >= request.quantity,
    };
  }

  /**
   * Takes units off the shelf for an order.
   *
   * @throws ConflictException when fewer than `quantity` units are left
   * @throws NotFoundException when the store does not sell the product
   */
  async reserveStock(request: StockRequest): Promise<StockMovement> {
    assertQuantity(request.quantity);

    const row = await this.moveStock(request, (current) => {
      if (current.stock < request.quantity) {
        throw new ConflictException(
          `Only ${current.stock} of product ${request.productId} left at store ${request.storeId}; ${request.quantity} requested`,
        );
      }

      return { ...current, stock: current.stock - request.quantity };
    });

    return { ...request, stockAfter: row.stock };
  }

  /**
   * Puts reserved units back on the shelf, as when an order is cancelled.
   *
   * @throws NotFoundException when the store does not sell the product
   */
  async releaseStock(request: StockRequest): Promise<StockMovement> {
    assertQuantity(request.quantity);

    const row = await this.moveStock(request, (current) => ({
      ...current,
      stock: current.stock + request.quantity,
    }));

    return { ...request, stockAfter: row.stock };
  }

  /**
   * Puts a product on an open store's shelf, or changes its price and stock.
   *
   * @throws NotFoundException when the store or product does not exist
   * @throws ConflictException when the store is closed
   */
  async upsertListing(listing: ListingUpsert): Promise<StoreListing> {
    await this.stores.getOpenStore(listing.storeId);

    const product = await this.products.getProduct(listing.productId);
    const existing = await this.listings.findListing(listing);
    const row = existing
      ? await this.listings.update(existing.id, (current) => ({
          ...current,
          price: listing.price,
          stock: listing.stock,
        }))
      : await orConflict(
          this.listings.insert(listing),
          `Product ${listing.productId} was listed at store ${listing.storeId} at the same moment; send the request again`,
        );

    if (!row) {
      throw notSoldHere(listing);
    }

    return toStoreListing(row, product);
  }

  private async moveStock(
    request: StockRequest,
    change: (current: StoreProductRow) => StoreProductRow,
  ): Promise<StoreProductRow> {
    const listing = await this.listings.findListing(request);
    const row = listing ? await this.listings.update(listing.id, change) : null;

    if (!row) {
      throw notSoldHere(request);
    }

    return row;
  }
}

function toStoreListing(
  row: StoreProductRow,
  product: ProductRow,
): StoreListing {
  return {
    storeId: row.storeId,
    productId: row.productId,
    sku: product.sku,
    name: product.name,
    category: product.category,
    price: row.price,
    stock: row.stock,
  };
}

function notSoldHere({ storeId, productId }: ShelfItemRef): NotFoundException {
  return new NotFoundException(
    `Product ${productId} is not sold at store ${storeId}`,
  );
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new BadRequestException(
      `quantity must be a whole number between 1 and ${MAX_QUANTITY}`,
    );
  }
}
