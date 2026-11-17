import { Injectable } from '@nestjs/common';
import type { ProductCategory, ProductRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { NewProduct } from './product.dto';

/** Reads and writes the products table. */
@Injectable()
export class ProductRepository {
  private readonly products: InMemoryTable<ProductRow>;

  constructor(database: DatabaseService) {
    this.products = database.products;
  }

  findById(productId: string): Promise<ProductRow | null> {
    return this.products.findById(productId);
  }

  /** Products still sold, optionally only those in one category. */
  listActive(category?: ProductCategory): Promise<ProductRow[]> {
    return this.products.findMany(
      (product) =>
        product.archivedAt === null &&
        (category === undefined || product.category === category),
    );
  }

  /** The products among `productIds` that are still sold. */
  findActiveByIds(productIds: readonly string[]): Promise<ProductRow[]> {
    const wanted = new Set(productIds);

    return this.products.findMany(
      (product) => product.archivedAt === null && wanted.has(product.id),
    );
  }

  /** @throws UniqueConstraintViolationError when the SKU is taken */
  insert(product: NewProduct): Promise<ProductRow> {
    return this.products.insert((metadata) => ({
      ...metadata,
      ...product,
      archivedAt: null,
    }));
  }

  /** Replaces a product with what `change` makes of it; `null` when there is none. */
  update<N extends ProductRow>(
    productId: string,
    change: (current: ProductRow) => N,
  ): Promise<N | null> {
    return this.products.update(productId, change);
  }
}
