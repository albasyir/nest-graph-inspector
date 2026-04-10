import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ProductService } from './product.service';

@Controller('products')
export class ProductController {
  constructor(private readonly productService: ProductService) {}

  @Post()
  createProduct(@Body() body: { name: string; price: number; ownerId: number }) {
    return this.productService.createProduct(body.name, body.price, body.ownerId);
  }

  @Get()
  getAllProducts() {
    return this.productService.getAllProducts();
  }

  @Get(':id')
  getProductById(@Param('id') id: string) {
    return this.productService.getProductById(Number(id));
  }
}
