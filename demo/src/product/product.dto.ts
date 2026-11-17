import { BadRequestException } from '@nestjs/common';
import {
  optionalOneOf,
  optionalText,
  parseJsonObject,
  parseOptionalQuery,
  requireOneOf,
  requireText,
} from '../common/request-parsing';
import {
  PRODUCT_CATEGORIES,
  type ProductCategory,
  type ProductRow,
} from '../database/database.schema';

/** A catalogue entry; `archivedAt` is set once it is no longer sold. */
export type Product = ProductRow;

/** What it takes to add a product to the catalogue. */
export type NewProduct = Pick<
  ProductRow,
  'sku' | 'name' | 'description' | 'category'
>;

/** A product update; a field left out stays as it is. The SKU never changes. */
export type ProductChanges = Partial<
  Pick<ProductRow, 'name' | 'description' | 'category'>
>;

/** Which products to list. */
export interface ProductListQuery {
  /** Only products in this category. */
  readonly category?: ProductCategory;
}

/** A product customers often buy together with the one being looked at. */
export interface RelatedProduct {
  readonly productId: string;
  readonly name: string;
  readonly category: ProductCategory;
  /** How many paid orders held both products. */
  readonly timesBoughtTogether: number;
}

/** A product's page: the product, and what is frequently bought with it. */
export interface ProductDetail extends Product {
  readonly frequentlyBoughtTogether: readonly RelatedProduct[];
}

const SKU_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

/** Reads `POST /products`'s body. */
export function parseNewProduct(body: unknown): NewProduct {
  const source = parseJsonObject(body);
  const sku = requireText(source, 'sku', { maxLength: 32 }).toUpperCase();

  if (!SKU_PATTERN.test(sku)) {
    throw new BadRequestException(
      'sku must be 2 to 32 letters, digits or dashes, starting with a letter or digit',
    );
  }

  return {
    sku,
    name: requireText(source, 'name', { maxLength: 120 }),
    description: requireText(source, 'description', { maxLength: 500 }),
    category: requireOneOf(source, 'category', PRODUCT_CATEGORIES),
  };
}

/** Reads `PATCH /products/:productId`'s body. */
export function parseProductChanges(body: unknown): ProductChanges {
  const source = parseJsonObject(body);
  const name = optionalText(source, 'name', { maxLength: 120 });
  const description = optionalText(source, 'description', { maxLength: 500 });
  const category = optionalOneOf(source, 'category', PRODUCT_CATEGORIES);

  if (
    name === undefined &&
    description === undefined &&
    category === undefined
  ) {
    throw new BadRequestException(
      'Send at least one of: name, description, category',
    );
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
  };
}

/** Reads `GET /products`'s query string. */
export function parseProductListQuery(category: unknown): ProductListQuery {
  const parsed = parseOptionalQuery(category, 'category', PRODUCT_CATEGORIES);

  return parsed === undefined ? {} : { category: parsed };
}
