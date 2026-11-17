import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Public } from '../common/public.decorator';
import {
  parseNewProduct,
  parseProductChanges,
  parseProductListQuery,
  type Product,
  type ProductDetail,
} from './product.dto';
import { ProductService } from './product.service';

/**
 * The catalogue. Anyone may browse it; changing it takes a signed-in account
 * — in a real shop this would be staff only, which the demo does not model.
 */
@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  /** `GET /products?category=` — every product still sold. */
  @Public()
  @Get()
  listProducts(@Query('category') category: unknown): Promise<Product[]> {
    return this.productService.listProducts(parseProductListQuery(category));
  }

  /** `GET /products/:productId` — a product and what is bought with it. */
  @Public()
  @Get(':productId')
  getProductDetail(
    @Param('productId') productId: string,
  ): Promise<ProductDetail> {
    return this.productService.getProductDetail(productId);
  }

  /** `POST /products` — add a product to the catalogue. */
  @Post()
  createProduct(@Body() body: unknown): Promise<Product> {
    return this.productService.createProduct(parseNewProduct(body));
  }

  /** `PATCH /products/:productId` — change a product's details. */
  @Patch(':productId')
  updateProduct(
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<Product> {
    return this.productService.updateProduct(
      productId,
      parseProductChanges(body),
    );
  }

  /** `DELETE /products/:productId` — archive a product; it is kept, not erased. */
  @Delete(':productId')
  archiveProduct(@Param('productId') productId: string): Promise<Product> {
    return this.productService.archiveProduct(productId);
  }
}
