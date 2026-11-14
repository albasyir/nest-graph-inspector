import { Module } from '@nestjs/common';
import { CustomerLoyaltyController } from './customer-loyalty.controller';
import { CustomerLoyaltyRepository } from './customer-loyalty.repository';
import { CustomerLoyaltyService } from './customer-loyalty.service';
import { CustomerModule } from '../customer/customer.module';

/**
 * Loyalty points, tiers and tier discounts. Imports CustomerModule, so an
 * account is only ever opened for a customer who exists.
 */
@Module({
  imports: [CustomerModule],
  controllers: [CustomerLoyaltyController],
  providers: [CustomerLoyaltyRepository, CustomerLoyaltyService],
  exports: [CustomerLoyaltyService],
})
export class CustomerLoyaltyModule {}
