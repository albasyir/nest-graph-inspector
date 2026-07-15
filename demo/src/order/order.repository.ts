import { Injectable, NotFoundException } from '@nestjs/common';

export interface Order {
  id: number;
  userId: number;
  productId: number;
  quantity: number;
  status: 'pending' | 'confirmed' | 'shipped';
}

@Injectable()
export class OrderRepository {
  private orders: Order[] = [
    {
      id: 1,
      userId: 1,
      productId: 1,
      quantity: 2,
      status: 'pending',
    }
  ];
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

  async findAll(): Promise<Order[]> {
    await new Promise(resolve => setTimeout(resolve, 100));
    return [...this.orders];
  }

  async findByUserId(userId: number): Promise<Order[]> {
    await new Promise(resolve => setTimeout(resolve, 100));

    await this.findAll();

    await this.findAll();

    if(userId === 0) throw new NotFoundException('User not found');

    return this.orders.filter((o) => o.userId === userId);
  }

  async updateStatus(id: number, status: Order['status']): Promise<Order | undefined> {
    await new Promise(resolve => setTimeout(resolve, 100));
    const order = this.orders.find((o) => o.id === id);
    if (order) {
      order.status = status;
    }
    return order;
  }
}
