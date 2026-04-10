import { Injectable } from '@nestjs/common';

export interface Order {
  id: number;
  userId: number;
  productId: number;
  quantity: number;
  status: 'pending' | 'confirmed' | 'shipped';
}

@Injectable()
export class OrderRepository {
  private orders: Order[] = [];
  private nextId = 1;

  create(userId: number, productId: number, quantity: number): Order {
    const order: Order = {
      id: this.nextId++,
      userId,
      productId,
      quantity,
      status: 'pending',
    };
    this.orders.push(order);
    return order;
  }

  findById(id: number): Order | undefined {
    return this.orders.find((o) => o.id === id);
  }

  findAll(): Order[] {
    return [...this.orders];
  }

  findByUserId(userId: number): Order[] {
    return this.orders.filter((o) => o.userId === userId);
  }

  updateStatus(id: number, status: Order['status']): Order | undefined {
    const order = this.orders.find((o) => o.id === id);
    if (order) {
      order.status = status;
    }
    return order;
  }
}
