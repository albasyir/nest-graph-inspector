import { Injectable } from '@nestjs/common';
import type {
  BillRow,
  CredentialRow,
  CustomerRow,
  LoyaltyAccountRow,
  OrderRow,
  ProductRow,
  RewardRow,
  SessionRow,
  StoreProductRow,
  StoreRow,
  VoucherRedemptionRow,
  VoucherRow,
} from './database.schema';
import {
  SEED_BILLS,
  SEED_CREDENTIALS,
  SEED_CUSTOMERS,
  SEED_LOYALTY_ACCOUNTS,
  SEED_ORDERS,
  SEED_PRODUCTS,
  SEED_REWARDS,
  SEED_STORE_PRODUCTS,
  SEED_STORES,
  SEED_VOUCHERS,
} from './database.seed';
import {
  InMemoryTable,
  type InMemoryTableOptions,
  type RowMetadata,
} from './in-memory-table';
import { simulateDatabaseLatency } from './simulated-latency';

/**
 * The shop's database: every table, already holding the seed data.
 *
 * Provided once by the global DatabaseModule, so each feature module's
 * repository injects it without importing anything. Every operation on a
 * table costs one simulated round trip of 100–200 ms; nothing runs outside
 * the process.
 */
@Injectable()
export class DatabaseService {
  readonly stores: InMemoryTable<StoreRow>;
  readonly products: InMemoryTable<ProductRow>;
  readonly storeProducts: InMemoryTable<StoreProductRow>;
  readonly customers: InMemoryTable<CustomerRow>;
  readonly credentials: InMemoryTable<CredentialRow>;
  readonly sessions: InMemoryTable<SessionRow>;
  readonly loyaltyAccounts: InMemoryTable<LoyaltyAccountRow>;
  readonly vouchers: InMemoryTable<VoucherRow>;
  readonly voucherRedemptions: InMemoryTable<VoucherRedemptionRow>;
  readonly rewards: InMemoryTable<RewardRow>;
  readonly orders: InMemoryTable<OrderRow>;
  readonly bills: InMemoryTable<BillRow>;

  constructor() {
    this.stores = createTable<StoreRow>({
      name: 'stores',
      idPrefix: 'str',
      seed: SEED_STORES,
    });
    this.products = createTable<ProductRow>({
      name: 'products',
      idPrefix: 'prd',
      uniqueKeys: [['sku']],
      seed: SEED_PRODUCTS,
    });
    this.storeProducts = createTable<StoreProductRow>({
      name: 'store_products',
      idPrefix: 'stp',
      uniqueKeys: [['storeId', 'productId']],
      seed: SEED_STORE_PRODUCTS,
    });
    this.customers = createTable<CustomerRow>({
      name: 'customers',
      idPrefix: 'cus',
      uniqueKeys: [['email']],
      seed: SEED_CUSTOMERS,
    });
    this.credentials = createTable<CredentialRow>({
      name: 'credentials',
      idPrefix: 'crd',
      uniqueKeys: [['customerId']],
      seed: SEED_CREDENTIALS,
    });
    this.sessions = createTable<SessionRow>({
      name: 'sessions',
      idPrefix: 'ses',
      uniqueKeys: [['tokenHash']],
    });
    this.loyaltyAccounts = createTable<LoyaltyAccountRow>({
      name: 'loyalty_accounts',
      idPrefix: 'lya',
      uniqueKeys: [['customerId']],
      seed: SEED_LOYALTY_ACCOUNTS,
    });
    this.vouchers = createTable<VoucherRow>({
      name: 'vouchers',
      idPrefix: 'vch',
      uniqueKeys: [['code']],
      seed: SEED_VOUCHERS,
    });
    this.voucherRedemptions = createTable<VoucherRedemptionRow>({
      name: 'voucher_redemptions',
      idPrefix: 'vrd',
      uniqueKeys: [['voucherId', 'customerId']],
    });
    this.rewards = createTable<RewardRow>({
      name: 'rewards',
      idPrefix: 'rwd',
      seed: SEED_REWARDS,
    });
    this.orders = createTable<OrderRow>({
      name: 'orders',
      idPrefix: 'ord',
      seed: SEED_ORDERS,
    });
    this.bills = createTable<BillRow>({
      name: 'bills',
      idPrefix: 'bil',
      uniqueKeys: [['orderId'], ['gatewayReference']],
      seed: SEED_BILLS,
    });
  }
}

/** A table whose every operation pays the simulated database round trip. */
function createTable<T extends RowMetadata>(
  options: Omit<InMemoryTableOptions<T>, 'latency'>,
): InMemoryTable<T> {
  return new InMemoryTable<T>({ ...options, latency: simulateDatabaseLatency });
}
