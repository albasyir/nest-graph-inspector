import { Injectable } from '@nestjs/common';
import type {
  ReservedVoucherRedemptionRow,
  RewardRow,
  VoucherRedemptionRow,
  VoucherRow,
} from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';
import type { NewVoucher } from './voucher.dto';

type RedemptionKey = Pick<VoucherRedemptionRow, 'voucherId' | 'customerId'>;

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

  findRedemption(key: RedemptionKey): Promise<VoucherRedemptionRow | null> {
    return this.redemptions.findOne(
      (row) =>
        row.voucherId === key.voucherId && row.customerId === key.customerId,
    );
  }

  listRedemptions(customerId: string): Promise<VoucherRedemptionRow[]> {
    return this.redemptions.findMany((row) => row.customerId === customerId);
  }

  /**
   * Puts a voucher on an order, in one write.
   *
   * @throws UniqueConstraintViolationError when an order already holds or
   * spent it
   */
  insertReserved(
    redemption: RedemptionKey & Pick<VoucherRedemptionRow, 'orderId'>,
  ): Promise<ReservedVoucherRedemptionRow> {
    return this.redemptions.insert(
      (metadata): ReservedVoucherRedemptionRow => ({
        ...metadata,
        voucherId: redemption.voucherId,
        customerId: redemption.customerId,
        orderId: redemption.orderId,
        status: 'RESERVED',
      }),
    );
  }

  /** Replaces a redemption with what `change` makes of it; `null` when there is none. */
  updateRedemption<N extends VoucherRedemptionRow>(
    redemptionId: string,
    change: (current: VoucherRedemptionRow) => N,
  ): Promise<N | null> {
    return this.redemptions.update(redemptionId, change);
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
