import { Injectable } from '@nestjs/common';
import type {
  RewardRow,
  VoucherRedemptionRow,
  VoucherRow,
} from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { NewVoucher, VoucherRedemption } from './voucher.dto';

/** Reads and writes the vouchers, voucher_redemptions and rewards tables. */
@Injectable()
export class VoucherRepository {
  private readonly vouchers: InMemoryTable<VoucherRow>;
  private readonly redemptions: InMemoryTable<VoucherRedemptionRow>;
  private readonly rewards: InMemoryTable<RewardRow>;

  constructor(database: DatabaseService) {
    this.vouchers = database.vouchers;
    this.redemptions = database.voucherRedemptions;
    this.rewards = database.rewards;
  }

  findByCode(code: string): Promise<VoucherRow | null> {
    return this.vouchers.findOne((voucher) => voucher.code === code);
  }

  listPublic(): Promise<VoucherRow[]> {
    return this.vouchers.findMany(
      (voucher) => voucher.audience.kind === 'PUBLIC',
    );
  }

  listPersonal(customerId: string): Promise<VoucherRow[]> {
    return this.vouchers.findMany(
      (voucher) =>
        voucher.audience.kind === 'PERSONAL' &&
        voucher.audience.customerId === customerId,
    );
  }

  /** @throws UniqueConstraintViolationError when the code is taken */
  insert(voucher: NewVoucher): Promise<VoucherRow> {
    return this.vouchers.insert((metadata) => ({ ...metadata, ...voucher }));
  }

  findRedemption(
    redemption: Pick<VoucherRedemption, 'voucherId' | 'customerId'>,
  ): Promise<VoucherRedemptionRow | null> {
    return this.redemptions.findOne(
      (row) =>
        row.voucherId === redemption.voucherId &&
        row.customerId === redemption.customerId,
    );
  }

  listRedemptions(customerId: string): Promise<VoucherRedemptionRow[]> {
    return this.redemptions.findMany((row) => row.customerId === customerId);
  }

  /** @throws UniqueConstraintViolationError when the voucher was already used */
  insertRedemption(
    redemption: VoucherRedemption,
  ): Promise<VoucherRedemptionRow> {
    return this.redemptions.insert((metadata) => ({
      ...metadata,
      ...redemption,
    }));
  }

  deleteRedemption(redemptionId: string): Promise<boolean> {
    return this.redemptions.delete(redemptionId);
  }

  findReward(rewardId: string): Promise<RewardRow | null> {
    return this.rewards.findById(rewardId);
  }

  listRewards(): Promise<RewardRow[]> {
    return this.rewards.findMany();
  }
}
