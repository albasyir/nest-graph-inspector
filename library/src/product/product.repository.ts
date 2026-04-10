import { Injectable } from '@nestjs/common';

export interface Product {
  id: number;
  name: string;
  price: number;
  ownerId: number;
}

@Injectable()
export class ProductRepository {
  private products: Product[] = [];
  private nextId = 1;

  create(name: string, price: number, ownerId: number): Product {
    const product: Product = { id: this.nextId++, name, price, ownerId };
    this.products.push(product);
    return product;
  }

  findById(id: number): Product | undefined {
    return this.products.find((p) => p.id === id);
  }

  findAll(): Product[] {
    return [...this.products];
  }

  findByOwnerId(ownerId: number): Product[] {
    return this.products.filter((p) => p.ownerId === ownerId);
  }
}
