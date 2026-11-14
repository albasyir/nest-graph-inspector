import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { orConflict } from '../common/conflict';
import { formatRupiah } from '../common/money';
import { CustomerLoyaltyService } from '../customer-loyalty/customer-loyalty.service';
import type {
  UsedVoucherRedemptionRow,
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
  type VoucherOnOrder,
  type VoucherQuote,
  type VoucherQuoteRequest,
  type VoucherUsage,
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
 * subtotal, and how much does it take off — then reserves the voucher on its
 * order; paying the order spends it, cancelling the order frees it. One row
 * per voucher and customer carries all three states, so a voucher can never
 * be on two orders at once. Claiming a reward spends points through
 * CustomerLoyaltyService, which is why this module imports that one.
 */
@Injectable()
export class VoucherService {
  private readonly logger = new Logger(VoucherService.name);

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
      await this.refundAfterFailure(claim, reward.pointsCost);
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
   * @throws ConflictException when this customer has already used it, or it
   * is on another of their orders, waiting for payment
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

    const held = await this.vouchers.findRedemption({
      voucherId: voucher.id,
      customerId: request.customerId,
    });
    if (held) {
      throw new ConflictException(describeHold(code, held));
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
   * Puts a quoted voucher on an order, in one write: of two orders racing
   * for the same voucher, exactly one gets it.
   *
   * @throws ConflictException when another order already holds or spent it
   */
  async reserve(hold: VoucherOnOrder): Promise<void> {
    await orConflict(
      this.vouchers.insertReserved(hold),
      `Voucher ${hold.code} was put on another order at the same moment`,
    );
  }

  /**
   * Spends the voucher an order holds, once that order is paid. Checked and
   * written in one step, so a voucher is spent at most once.
   *
   * @throws ConflictException when the order does not hold the voucher
   */
  async markUsed(hold: VoucherOnOrder): Promise<void> {
    const notHeld = () =>
      new ConflictException(
        `Voucher ${hold.code} is not held by order ${hold.orderId}`,
      );
    const row = await this.vouchers.findRedemption(hold);

    if (!row) {
      throw notHeld();
    }

    const used = await this.vouchers.updateRedemption(
      row.id,
      (current): UsedVoucherRedemptionRow => {
        if (current.status !== 'RESERVED' || current.orderId !== hold.orderId) {
          throw notHeld();
        }

        return { ...current, status: 'USED', usedAt: new Date().toISOString() };
      },
    );

    if (!used) {
      throw notHeld();
    }
  }

  /**
   * Frees the voucher a cancelled order held, so it can be used again. Only a
   * reserved voucher is freed — a spent one stays spent — and an order that
   * holds none, such as one whose checkout lost the voucher to another
   * order, has nothing to free.
   */
  async release(hold: VoucherOnOrder): Promise<void> {
    const row = await this.vouchers.findRedemption(hold);

    if (row?.status === 'RESERVED' && row.orderId === hold.orderId) {
      await this.vouchers.deleteRedemption(row.id);
    }
  }

  /** Hands back the points of a claim that failed after spending them. */
  private async refundAfterFailure(
    claim: RewardClaim,
    points: number,
  ): Promise<void> {
    try {
      await this.loyalty.refundPoints({ customerId: claim.customerId, points });
    } catch (error) {
      this.logger.error(
        `Could not refund ${points} points to customer ${claim.customerId} after claiming reward ${claim.rewardId} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
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
    usage: usageOf(voucher, redemption, now),
  };
}

function usageOf(
  voucher: VoucherRow,
  redemption: VoucherRedemptionRow | null,
  now: Date,
): VoucherUsage {
  if (!redemption) {
    return hasExpired(voucher, now)
      ? { status: 'EXPIRED' }
      : { status: 'AVAILABLE' };
  }

  switch (redemption.status) {
    case 'RESERVED':
      return { status: 'RESERVED', orderId: redemption.orderId };
    case 'USED':
      return {
        status: 'USED',
        orderId: redemption.orderId,
        usedAt: redemption.usedAt,
      };
    default: {
      const _exhaustive: never = redemption;

      return _exhaustive;
    }
  }
}

/** Why a voucher this customer already has on an order cannot be quoted. */
function describeHold(code: string, held: VoucherRedemptionRow): string {
  switch (held.status) {
    case 'RESERVED':
      return `Voucher ${code} is already on order ${held.orderId}, which is waiting for payment; pay or cancel that order first`;
    case 'USED':
      return `Voucher ${code} was already used on order ${held.orderId}`;
    default: {
      const _exhaustive: never = held;

      return _exhaustive;
    }
  }
}

/** `RWD-` and eight unambiguous characters, from a secure random source. */
function newRewardVoucherCode(): string {
  const characters = Array.from(
    randomBytes(8),
    (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
  );

  return `RWD-${characters.join('')}`;
}
