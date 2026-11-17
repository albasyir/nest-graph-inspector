import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { CustomerRepository } from './customer.repository';
import { CustomerService } from './customer.service';

/**
 * Customers: profiles, and finding a customer by id or email. Imports no
 * other feature module — Auth and CustomerLoyalty build on this one.
 */
@Module({
  controllers: [CustomerController],
  providers: [CustomerRepository, CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
