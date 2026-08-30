import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { MobileService } from '../mobile/mobile.service';
import { ProductRepository, Product } from './product.repository';

/**
 * Product use cases, and the awkward wiring the graph is meant to reveal:
 *
 * - it reaches into MobileService through a property-injected forwardRef
 * - its module imports UserModule and never uses it
 */
@Injectable()
export class ProductService {
  @Inject(forwardRef(() => MobileService))
  private readonly mobileService!: MobileService;

  constructor(private readonly productRepository: ProductRepository) {}

  createProduct(name: string, price: number, ownerId: number): Product {
    return this.productRepository.create(name, price, ownerId);
  }

  getProductById(id: number): Product | undefined {
    return this.productRepository.findById(id);
  }

  async getAllProducts(): Promise<Product[]> {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return this.productRepository.findAll();
  }

  getProductsByOwner(ownerId: number): Product[] {
    return this.productRepository.findByOwnerId(ownerId);
  }

  getMobileFeaturedProductName(): string | undefined {
    return this.mobileService.getFeaturedProductName();
  }
}
