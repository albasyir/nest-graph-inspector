import { Module } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { VoucherRepository } from './voucher.repository';
import { VoucherService } from './voucher.service';
import { CustomerLoyaltyModule } from '../customer-loyalty/customer-loyalty.module';

/**
 * Vouchers and the loyalty reward catalogue. Imports CustomerLoyaltyModule to
 * spend a customer's points when they claim a reward.
 */
@Module({
  imports: [CustomerLoyaltyModule],
  controllers: [VoucherController],
  providers: [VoucherRepository, VoucherService],
  exports: [VoucherService],
})
export class VoucherModule {}
