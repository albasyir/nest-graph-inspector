import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProductService } from '../product/product.service';

@Injectable()
export class MobileService {
  constructor(
    @Inject(forwardRef(() => ProductService))
    private readonly productService: ProductService,
    private readonly configService: ConfigService,
  ) {}

  getFeaturedProductName(productId?: number): string | undefined {
    const configuredProductId = Number(
      this.configService.get<string>('MOBILE_FEATURED_PRODUCT_ID', '1'),
    );
    const featuredProductId =
      productId ??
      (Number.isInteger(configuredProductId) && configuredProductId > 0
        ? configuredProductId
        : 1);

    return this.productService.getProductById(featuredProductId)?.name;
  }
}
