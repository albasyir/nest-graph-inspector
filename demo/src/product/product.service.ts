import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { orConflict } from '../common/conflict';
import { MAX_RECOMMENDATION_LIMIT } from '../recommendation/recommendation.dto';
import { RecommendationService } from '../recommendation/recommendation.service';
import type {
  NewProduct,
  Product,
  ProductChanges,
  ProductDetail,
  ProductListQuery,
  RelatedProduct,
} from './product.dto';
import { ProductRepository } from './product.repository';

/** How many "frequently bought together" products a detail page shows. */
const RELATED_PRODUCT_LIMIT = 3;

/**
 * The product catalogue: what the shop sells, whatever the store.
 *
 * A product's detail also lists what customers frequently buy with it, which
 * RecommendationService works out from paid orders. That call is what puts
 * this module on a loop of imports — Product → Recommendation → Order →
 * StoreProduct → Product — and why it is injected through forwardRef().
 *
 * A product leaves the catalogue by being archived, never deleted: orders and
 * store shelves still refer to it.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly products: ProductRepository,
    @Inject(forwardRef(() => RecommendationService))
    private readonly recommendations: RecommendationService,
  ) {}

  /** Every product still sold, optionally only one category's. */
  listProducts(query: ProductListQuery = {}): Promise<Product[]> {
    return this.products.listActive(query.category);
  }

  /**
   * One product that is still sold.
   *
   * @throws NotFoundException when there is no such product, or it is archived
   */
  async getProduct(productId: string): Promise<Product> {
    const product = await this.products.findById(productId);

    if (!product || product.archivedAt !== null) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    return product;
  }

  /**
   * A product with the products most often bought together with it — the
   * top three still sold: archived products are dropped before the three are
   * chosen, so one leaving the catalogue makes room for the next.
   *
   * @throws NotFoundException when there is no such product, or it is archived
   */
  async getProductDetail(productId: string): Promise<ProductDetail> {
    const product = await this.getProduct(productId);
    const together = await this.recommendations.frequentlyBoughtTogether({
      productId,
      limit: MAX_RECOMMENDATION_LIMIT,
    });
    const stillSold = together.length
      ? await this.products.findActiveByIds(
          together.map((item) => item.productId),
        )
      : [];
    const byId = new Map(stillSold.map((related) => [related.id, related]));

    const frequentlyBoughtTogether = together.flatMap(
      (item): RelatedProduct[] => {
        const related = byId.get(item.productId);

        return related
          ? [
              {
                productId: related.id,
                name: related.name,
                category: related.category,
                timesBoughtTogether: item.timesBoughtTogether,
              },
            ]
          : [];
      },
    );

    return {
      ...product,
      frequentlyBoughtTogether: frequentlyBoughtTogether.slice(
        0,
        RELATED_PRODUCT_LIMIT,
      ),
    };
  }

  /** The products among `productIds` that are still sold; unknown ids are skipped. */
  findProducts(productIds: readonly string[]): Promise<Product[]> {
    return this.products.findActiveByIds(productIds);
  }

  /**
   * Adds a product to the catalogue.
   *
   * @throws ConflictException when another product has the same SKU
   */
  createProduct(product: NewProduct): Promise<Product> {
    return orConflict(
      this.products.insert(product),
      `SKU ${product.sku} is already in the catalogue`,
    );
  }

  /**
   * Changes a product's name, description or category.
   *
   * @throws NotFoundException when there is no such product, or it is archived
   */
  async updateProduct(
    productId: string,
    changes: ProductChanges,
  ): Promise<Product> {
    const product = await this.products.update(productId, (current) => {
      if (current.archivedAt !== null) {
        throw new NotFoundException(`Product ${productId} not found`);
      }

      return {
        ...current,
        name: changes.name ?? current.name,
        description: changes.description ?? current.description,
        category: changes.category ?? current.category,
      };
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    return product;
  }

  /**
   * Takes a product out of the catalogue. Its history stays: past orders keep
   * the name it was sold under.
   *
   * @throws NotFoundException when there is no such product
   * @throws ConflictException when it is already archived
   */
  async archiveProduct(productId: string): Promise<Product> {
    const product = await this.products.update(productId, (current) => {
      if (current.archivedAt !== null) {
        throw new ConflictException(`Product ${productId} is already archived`);
      }

      return { ...current, archivedAt: new Date().toISOString() };
    });

    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    return product;
  }
}
