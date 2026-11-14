import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { orConflict } from '../common/conflict';
import { formatRupiah } from '../common/money';
import { CustomerLoyaltyService } from '../customer-loyalty/customer-loyalty.service';
import type {
  VoucherRedemptionRow,
  VoucherRow,
} from '../database/database.schema';
import { discountFor, hasExpired } from './voucher-discount';
import {
  type ClaimedReward,
  type CustomerVoucher,
  normalizeVoucherCode,
  type PublicVoucher,
  type Reward,
  type RewardClaim,
  type VoucherQuote,
  type VoucherQuoteRequest,
  type VoucherRedemption,
} from './voucher.dto';
import { VoucherRepository } from './voucher.repository';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** 32 letters and digits that cannot be misread for one another. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Discount vouchers: public codes each customer may use once, and personal
 * ones customers claim from the reward catalogue with loyalty points.
 *
 * Checkout asks for a quote — may this customer use this code on this
 * subtotal, and how much does it take off — and paying the order marks the
 * voucher used. Claiming a reward spends points through
 * CustomerLoyaltyService, which is why this module imports that one.
 */
@Injectable()
export class VoucherService {
  constructor(
    private readonly vouchers: VoucherRepository,
    private readonly loyalty: CustomerLoyaltyService,
  ) {}

  /** Public vouchers that have not expired. */
  async listPublicVouchers(): Promise<PublicVoucher[]> {
    const now = new Date();
    const vouchers = await this.vouchers.listPublic();

    return vouchers
      .filter((voucher) => !hasExpired(voucher, now))
      .map((voucher) => ({
        code: voucher.code,
        title: voucher.title,
        discount: voucher.discount,
        minSpend: voucher.minSpend,
        expiresAt: voucher.expiresAt,
      }));
  }

  /** The reward catalogue: vouchers that can be bought with points. */
  listRewards(): Promise<Reward[]> {
    return this.vouchers.listRewards();
  }

  /**
   * Every voucher a customer can see — their personal ones and the public
   * ones — and whether each is still usable by them.
   */
  async listCustomerVouchers(customerId: string): Promise<CustomerVoucher[]> {
    const now = new Date();
    const [personal, publicVouchers, redemptions] = await Promise.all([
      this.vouchers.listPersonal(customerId),
      this.vouchers.listPublic(),
      this.vouchers.listRedemptions(customerId),
    ]);
    const usedBy = new Map(
      redemptions.map((redemption) => [redemption.voucherId, redemption]),
    );

    return [...personal, ...publicVouchers].map((voucher) =>
      toCustomerVoucher(voucher, usedBy.get(voucher.id) ?? null, now),
    );
  }

  /**
   * Claims a reward: spends its points and issues a personal voucher only
   * this customer can use.
   *
   * @throws NotFoundException when the reward or the customer does not exist
   * @throws ConflictException when the customer has too few points
   */
  async claimReward(claim: RewardClaim): Promise<ClaimedReward> {
    const reward = await this.vouchers.findReward(claim.rewardId);
    if (!reward) {
      throw new NotFoundException(`Reward ${claim.rewardId} not found`);
    }

    const account = await this.loyalty.redeemPoints({
      customerId: claim.customerId,
      points: reward.pointsCost,
    });

    try {
      const now = new Date();
      const voucher = await this.vouchers.insert({
        code: newRewardVoucherCode(),
        title: reward.title,
        discount: reward.discount,
        minSpend: reward.minSpend,
        expiresAt: new Date(
          now.getTime() + reward.validForDays * DAY_MS,
        ).toISOString(),
        audience: {
          kind: 'PERSONAL',
          customerId: claim.customerId,
          rewardId: reward.id,
        },
      });

      return {
        voucher: toCustomerVoucher(voucher, null, now),
        pointsSpent: reward.pointsCost,
        pointsBalance: account.pointsBalance,
      };
    } catch (error) {
      // The points are already spent: hand them back before failing.
      await this.loyalty.refundPoints({
        customerId: claim.customerId,
        points: reward.pointsCost,
      });
      throw error;
    }
  }

  /**
   * Checks a code for one customer and subtotal and works out its discount.
   *
   * @throws NotFoundException when no voucher has this code
   * @throws ForbiddenException when it is another customer's personal voucher
   * @throws BadRequestException when it has expired, or the subtotal is below
   * its minimum spend
   * @throws ConflictException when this customer has already used it
   */
  async quoteDiscount(request: VoucherQuoteRequest): Promise<VoucherQuote> {
    const code = normalizeVoucherCode(request.code);
    const voucher = await this.vouchers.findByCode(code);

    if (!voucher) {
      throw new NotFoundException(`Voucher ${code} does not exist`);
    }

    if (
      voucher.audience.kind === 'PERSONAL' &&
      voucher.audience.customerId !== request.customerId
    ) {
      throw new ForbiddenException(
        `Voucher ${code} belongs to another customer`,
      );
    }

    if (hasExpired(voucher, new Date())) {
      throw new BadRequestException(
        `Voucher ${code} expired at ${voucher.expiresAt}`,
      );
    }

    const redemption = await this.vouchers.findRedemption({
      voucherId: voucher.id,
      customerId: request.customerId,
    });
    if (redemption) {
      throw new ConflictException(
        `Voucher ${code} was already used on order ${redemption.orderId}`,
      );
    }

    if (request.subtotal < voucher.minSpend) {
      throw new BadRequestException(
        `Voucher ${code} needs a subtotal of at least ${formatRupiah(voucher.minSpend)}; this one is ${formatRupiah(request.subtotal)}`,
      );
    }

    return {
      voucherId: voucher.id,
      code: voucher.code,
      title: voucher.title,
      discountAmount: discountFor(voucher.discount, request.subtotal),
    };
  }

  /**
   * Records a voucher as spent on a paid order. Unique per voucher and
   * customer, so it can never be spent twice.
   *
   * @throws ConflictException when the customer has already used it
   */
  async markUsed(redemption: VoucherRedemption): Promise<void> {
    await orConflict(
      this.vouchers.insertRedemption(redemption),
      `Voucher ${redemption.voucherId} has already been used`,
    );
  }

  /**
   * Undoes `markUsed` for an order that ended up not being paid, so the
   * voucher can be used again.
   *
   * @throws NotFoundException when that order never used the voucher
   */
  async releaseRedemption(redemption: VoucherRedemption): Promise<void> {
    const row = await this.vouchers.findRedemption(redemption);

    if (!row || row.orderId !== redemption.orderId) {
      throw new NotFoundException(
        `Voucher ${redemption.voucherId} was not used on order ${redemption.orderId}`,
      );
    }

    await this.vouchers.deleteRedemption(row.id);
  }
}

function toCustomerVoucher(
  voucher: VoucherRow,
  redemption: VoucherRedemptionRow | null,
  now: Date,
): CustomerVoucher {
  return {
    voucherId: voucher.id,
    code: voucher.code,
    title: voucher.title,
    discount: voucher.discount,
    minSpend: voucher.minSpend,
    expiresAt: voucher.expiresAt,
    audience: voucher.audience.kind,
    usage: redemption
      ? {
          status: 'USED',
          orderId: redemption.orderId,
          usedAt: redemption.createdAt,
        }
      : hasExpired(voucher, now)
        ? { status: 'EXPIRED' }
        : { status: 'AVAILABLE' },
  };
}

/** `RWD-` and eight unambiguous characters, from a secure random source. */
function newRewardVoucherCode(): string {
  const characters = Array.from(
    randomBytes(8),
    (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
  );

  return `RWD-${characters.join('')}`;
}
