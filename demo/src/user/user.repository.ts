import { Injectable } from '@nestjs/common';

export interface User {
  id: number;
  name: string;
  email: string;
}

@Injectable()
export class UserRepository {
  private users: User[] = [];
  private nextId = 1;

  create(name: string, email: string): User {
    const user: User = { id: this.nextId++, name, email };
    this.users.push(user);
    return user;
  }

  findById(id: number): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  findAll(): User[] {
    return [...this.users];
  }
}
