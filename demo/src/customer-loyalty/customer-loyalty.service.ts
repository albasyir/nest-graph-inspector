import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerService } from '../customer/customer.service';
import type { LoyaltyAccountRow } from '../database/database.schema';
import { UniqueConstraintViolationError } from '../database/in-memory-table';
import type {
  LoyaltyAccount,
  LoyaltyProgramme,
  PointsChange,
  TierDiscount,
} from './customer-loyalty.dto';
import { CustomerLoyaltyRepository } from './customer-loyalty.repository';
import {
  pointsEarnedFor,
  RUPIAH_PER_POINT,
  TIER_RULES,
  tierAbove,
  tierFor,
} from './loyalty-rules';

/**
 * Loyalty points and the tier they earn.
 *
 * A paid order credits one point per full Rp 1.000; lifetime points set the
 * tier — Bronze, Silver from 1.000, Gold from 5.000 — and the tier takes a
 * percentage off at checkout. Points are spent on reward vouchers, through
 * VoucherService. An account is opened the first time points move; until
 * then a customer simply has none.
 */
@Injectable()
export class CustomerLoyaltyService {
  constructor(
    private readonly accounts: CustomerLoyaltyRepository,
    private readonly customers: CustomerService,
  ) {}

  /** How the programme works: the earn rate and every tier. */
  getProgramme(): LoyaltyProgramme {
    return { rupiahPerPoint: RUPIAH_PER_POINT, tiers: TIER_RULES };
  }

  /**
   * A customer's balance, tier, and distance to the next tier.
   *
   * @throws NotFoundException when there is no such customer
   */
  async getAccount(customerId: string): Promise<LoyaltyAccount> {
    const account = await this.accounts.findByCustomerId(customerId);

    if (account) {
      return toLoyaltyAccount(account);
    }

    await this.customers.getCustomer(customerId);

    return toLoyaltyAccount({
      customerId,
      pointsBalance: 0,
      lifetimePoints: 0,
    });
  }

  /**
   * The discount a customer's tier gives at checkout.
   *
   * @throws NotFoundException when there is no such customer
   */
  async getTierDiscount(customerId: string): Promise<TierDiscount> {
    const account = await this.getAccount(customerId);

    return { tier: account.tier, percent: account.tierDiscountPercent };
  }

  /** Points a payment of `amountPaid` rupiah earns. */
  pointsEarnedFor(amountPaid: number): number {
    return pointsEarnedFor(amountPaid);
  }

  /**
   * Credits earned points: they raise both the balance and the lifetime
   * total, which can lift the customer into a higher tier.
   *
   * @throws NotFoundException when there is no such customer
   */
  async addPoints(change: PointsChange): Promise<LoyaltyAccount> {
    assertPoints(change.points);

    const account = await this.openAccount(change.customerId);
    const updated = await this.accounts.update(account.id, (current) => ({
      ...current,
      pointsBalance: current.pointsBalance + change.points,
      lifetimePoints: current.lifetimePoints + change.points,
    }));

    return toLoyaltyAccount(updated ?? missingAccount(change.customerId));
  }

  /**
   * Spends points. The lifetime total — and so the tier — is unaffected.
   *
   * @throws ConflictException when the balance is smaller than `points`
   * @throws NotFoundException when there is no such customer
   */
  async redeemPoints(change: PointsChange): Promise<LoyaltyAccount> {
    assertPoints(change.points);

    const account = await this.accounts.findByCustomerId(change.customerId);
    if (!account) {
      await this.customers.getCustomer(change.customerId);
      throw notEnoughPoints(0, change.points);
    }

    const updated = await this.accounts.update(account.id, (current) => {
      if (current.pointsBalance < change.points) {
        throw notEnoughPoints(current.pointsBalance, change.points);
      }

      return {
        ...current,
        pointsBalance: current.pointsBalance - change.points,
      };
    });

    return toLoyaltyAccount(updated ?? missingAccount(change.customerId));
  }

  /**
   * Gives back points a redemption took, when what they paid for could not
   * be delivered. Only the balance moves: they were never earned twice.
   *
   * @throws NotFoundException when there is no such customer
   */
  async refundPoints(change: PointsChange): Promise<LoyaltyAccount> {
    assertPoints(change.points);

    const account = await this.openAccount(change.customerId);
    const updated = await this.accounts.update(account.id, (current) => ({
      ...current,
      pointsBalance: current.pointsBalance + change.points,
    }));

    return toLoyaltyAccount(updated ?? missingAccount(change.customerId));
  }

  /** The customer's account, opened empty if this is its first use. */
  private async openAccount(customerId: string): Promise<LoyaltyAccountRow> {
    const existing = await this.accounts.findByCustomerId(customerId);
    if (existing) {
      return existing;
    }

    await this.customers.getCustomer(customerId);

    try {
      return await this.accounts.open(customerId);
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationError)) {
        throw error;
      }

      // Another request opened it in the meantime: use that one.
      return (
        (await this.accounts.findByCustomerId(customerId)) ??
        missingAccount(customerId)
      );
    }
  }
}

function toLoyaltyAccount(
  account: Pick<
    LoyaltyAccountRow,
    'customerId' | 'pointsBalance' | 'lifetimePoints'
  >,
): LoyaltyAccount {
  const held = tierFor(account.lifetimePoints);
  const next = tierAbove(held.tier);

  return {
    customerId: account.customerId,
    pointsBalance: account.pointsBalance,
    lifetimePoints: account.lifetimePoints,
    tier: held.tier,
    tierDiscountPercent: held.discountPercent,
    nextTier: next
      ? {
          tier: next.tier,
          lifetimePointsNeeded: next.minLifetimePoints - account.lifetimePoints,
        }
      : null,
  };
}

function assertPoints(points: number): void {
  if (!Number.isInteger(points) || points < 1) {
    throw new BadRequestException(
      'points must be a whole number of at least 1',
    );
  }
}

function notEnoughPoints(balance: number, needed: number): ConflictException {
  return new ConflictException(
    `Not enough points: the balance is ${balance}, this needs ${needed}`,
  );
}

/** Accounts are never deleted, so one that vanished mid-update is not there. */
function missingAccount(customerId: string): never {
  throw new NotFoundException(
    `Loyalty account of customer ${customerId} not found`,
  );
}
