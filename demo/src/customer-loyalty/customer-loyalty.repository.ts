import { Injectable } from '@nestjs/common';
import type { LoyaltyAccountRow } from '../database/database.schema';
import { DatabaseService } from '../database/database.service';
import type { InMemoryTable } from '../database/in-memory-table';

/** Reads and writes the loyalty_accounts table. */
@Injectable()
export class CustomerLoyaltyRepository {
  private readonly accounts: InMemoryTable<LoyaltyAccountRow>;

  constructor(database: DatabaseService) {
    this.accounts = database.loyaltyAccounts;
  }

  findByCustomerId(customerId: string): Promise<LoyaltyAccountRow | null> {
    return this.accounts.findOne(
      (account) => account.customerId === customerId,
    );
  }

  /**
   * Opens an empty account.
   *
   * @throws UniqueConstraintViolationError when the customer already has one
   */
  open(customerId: string): Promise<LoyaltyAccountRow> {
    return this.accounts.insert((metadata) => ({
      ...metadata,
      customerId,
      pointsBalance: 0,
      lifetimePoints: 0,
    }));
  }

  /** Replaces an account with what `change` makes of it; `null` when there is none. */
  update<N extends LoyaltyAccountRow>(
    accountId: string,
    change: (current: LoyaltyAccountRow) => N,
  ): Promise<N | null> {
    return this.accounts.update(accountId, change);
  }
}
