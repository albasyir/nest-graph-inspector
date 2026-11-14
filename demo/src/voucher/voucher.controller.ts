import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentCustomerId } from '../common/current-customer.decorator';
import { Public } from '../common/public.decorator';
import {
  type ClaimedReward,
  type CustomerVoucher,
  parseVoucherQuoteBody,
  type PublicVoucher,
  type Reward,
  type VoucherQuote,
} from './voucher.dto';
import { VoucherService } from './voucher.service';

/**
 * Vouchers and loyalty rewards. Anyone may browse the public vouchers and
 * the reward catalogue; a wallet, a claim or a quote needs a signed-in
 * customer.
 */
@Controller('vouchers')
export class VoucherController {
  constructor(private readonly voucherService: VoucherService) {}

  /** `GET /vouchers` — public vouchers that have not expired. */
  @Public()
  @Get()
  listPublicVouchers(): Promise<PublicVoucher[]> {
    return this.voucherService.listPublicVouchers();
  }

  /** `GET /vouchers/rewards` — vouchers that can be bought with points. */
  @Public()
  @Get('rewards')
  listRewards(): Promise<Reward[]> {
    return this.voucherService.listRewards();
  }

  /** `GET /vouchers/mine` — the signed-in customer's wallet. */
  @Get('mine')
  listMyVouchers(
    @CurrentCustomerId() customerId: string,
  ): Promise<CustomerVoucher[]> {
    return this.voucherService.listCustomerVouchers(customerId);
  }

  /** `POST /vouchers/rewards/:rewardId/claim` — spend points on a reward voucher. */
  @Post('rewards/:rewardId/claim')
  claimReward(
    @CurrentCustomerId() customerId: string,
    @Param('rewardId') rewardId: string,
  ): Promise<ClaimedReward> {
    return this.voucherService.claimReward({ customerId, rewardId });
  }

  /** `POST /vouchers/quote` — what a code would take off a subtotal. */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  quote(
    @CurrentCustomerId() customerId: string,
    @Body() body: unknown,
  ): Promise<VoucherQuote> {
    return this.voucherService.quoteDiscount({
      customerId,
      ...parseVoucherQuoteBody(body),
    });
  }
}
