import { Controller, Get } from '@nestjs/common';
import { CurrentCustomerId } from '../common/current-customer.decorator';
import { Public } from '../common/public.decorator';
import type { LoyaltyAccount, LoyaltyProgramme } from './customer-loyalty.dto';
import { CustomerLoyaltyService } from './customer-loyalty.service';

/**
 * The loyalty programme: its rules for anyone, and the signed-in customer's
 * own balance and tier. Points move only through orders and rewards.
 */
@Controller('loyalty')
export class CustomerLoyaltyController {
  constructor(private readonly loyaltyService: CustomerLoyaltyService) {}

  /** `GET /loyalty/tiers` — the earn rate and every tier. */
  @Public()
  @Get('tiers')
  getProgramme(): LoyaltyProgramme {
    return this.loyaltyService.getProgramme();
  }

  /** `GET /loyalty/me` — the signed-in customer's points and tier. */
  @Get('me')
  getMyAccount(
    @CurrentCustomerId() customerId: string,
  ): Promise<LoyaltyAccount> {
    return this.loyaltyService.getAccount(customerId);
  }
}
