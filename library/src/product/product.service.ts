import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { MobileService } from '../mobile/mobile.service';
import { ProductRepository, Product } from './product.repository';

@Injectable()
export class ProductService {
  @Inject(forwardRef(() => MobileService))
  private readonly mobileService: MobileService;

  constructor(private readonly productRepository: ProductRepository) {}

  createProduct(name: string, price: number, ownerId: number): Product {
    return this.productRepository.create(name, price, ownerId);
  }

  getProductById(id: number): Product | undefined {
    return this.productRepository.findById(id);
  }

  getAllProducts(): Product[] {
    return this.productRepository.findAll();
  }

  getProductsByOwner(ownerId: number): Product[] {
    return this.productRepository.findByOwnerId(ownerId);
  }

  getMobileFeaturedProductName(productId: number): string | undefined {
    return this.mobileService.getFeaturedProductName(productId);
  }
}
