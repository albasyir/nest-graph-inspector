import { Injectable } from '@nestjs/common';
import type { CustomerRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { CustomerProfileChanges, NewCustomer } from './customer.dto';

/** Reads and writes the customers table. */
@Injectable()
export class CustomerRepository {
  private readonly customers: InMemoryTable<CustomerRow>;

  constructor(database: DatabaseService) {
    this.customers = database.customers;
  }

  findById(customerId: string): Promise<CustomerRow | null> {
    return this.customers.findById(customerId);
  }

  findByEmail(email: string): Promise<CustomerRow | null> {
    return this.customers.findOne((customer) => customer.email === email);
  }

  /** @throws UniqueConstraintViolationError when the email is taken */
  insert(customer: NewCustomer): Promise<CustomerRow> {
    return this.customers.insert((metadata) => ({ ...metadata, ...customer }));
  }

  update(
    customerId: string,
    changes: CustomerProfileChanges,
  ): Promise<CustomerRow | null> {
    return this.customers.update(customerId, (current) => ({
      ...current,
      name: changes.name ?? current.name,
      phone: changes.phone === undefined ? current.phone : changes.phone,
    }));
  }
}
