import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ProductService } from '../product/product.service';

@Injectable()
export class MobileService {
  constructor(
    @Inject(forwardRef(() => ProductService))
    private readonly productService: ProductService,
  ) {}

  getFeaturedProductName(productId: number): string | undefined {
    return this.productService.getProductById(productId)?.name;
  }
}
