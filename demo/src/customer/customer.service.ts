import { Injectable, NotFoundException } from '@nestjs/common';
import { orConflict } from '../common/conflict';
import type {
  Customer,
  CustomerProfileChanges,
  NewCustomer,
} from './customer.dto';
import { CustomerRepository } from './customer.repository';

/**
 * Customer profiles: who shops here and how to reach them.
 *
 * Other modules go through this service, never the customers table: Auth
 * registers customers and finds them by email to sign them in, and
 * CustomerLoyalty checks an account belongs to a real customer. Emails are
 * kept lower-cased; this service is where that rule lives.
 */
@Injectable()
export class CustomerService {
  constructor(private readonly customers: CustomerRepository) {}

  /**
   * One customer.
   *
   * @throws NotFoundException when there is no customer with this id
   */
  async getCustomer(customerId: string): Promise<Customer> {
    const customer = await this.customers.findById(customerId);

    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    return customer;
  }

  /** The customer registered under an email address, or `null`. */
  findByEmail(email: string): Promise<Customer | null> {
    return this.customers.findByEmail(normalizeEmail(email));
  }

  /**
   * Registers a customer.
   *
   * @throws ConflictException when the email address is already registered
   */
  createCustomer(customer: NewCustomer): Promise<Customer> {
    return orConflict(
      this.customers.insert({
        ...customer,
        email: normalizeEmail(customer.email),
      }),
      'This email address is already registered',
    );
  }

  /**
   * Changes a customer's name or phone number; what is left out stays as it is.
   *
   * @throws NotFoundException when there is no customer with this id
   */
  async updateProfile(
    customerId: string,
    changes: CustomerProfileChanges,
  ): Promise<Customer> {
    const customer = await this.customers.update(customerId, changes);

    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    return customer;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
