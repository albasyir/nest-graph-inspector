import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentCustomerId } from '../common/current-customer.decorator';
import { type Customer, parseCustomerProfileChanges } from './customer.dto';
import { CustomerService } from './customer.service';

/**
 * The signed-in customer's own profile. There is deliberately no route to
 * read anybody else's.
 */
@Controller('customers')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  /** `GET /customers/me` — the signed-in customer's profile. */
  @Get('me')
  getMyProfile(@CurrentCustomerId() customerId: string): Promise<Customer> {
    return this.customerService.getCustomer(customerId);
  }

  /** `PATCH /customers/me` — change the signed-in customer's name or phone. */
  @Patch('me')
  updateMyProfile(
    @CurrentCustomerId() customerId: string,
    @Body() body: unknown,
  ): Promise<Customer> {
    return this.customerService.updateProfile(
      customerId,
      parseCustomerProfileChanges(body),
    );
  }
}
