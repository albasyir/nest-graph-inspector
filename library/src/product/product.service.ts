import { Injectable } from '@nestjs/common';
import { ProductRepository, Product } from './product.repository';

@Injectable()
export class ProductService {
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
}
