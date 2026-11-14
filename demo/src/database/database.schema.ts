import type { RowMetadata } from './in-memory-table';

/**
 * The shape of everything the shop stores, one interface per table.
 *
 * This file is the single source of truth for stored data: feature modules
 * derive the types they hand around from these rows rather than declaring
 * parallel ones. Amounts are whole rupiah (IDR has no smaller unit in use),
 * timestamps are ISO-8601 strings in UTC.
 */

export const PRODUCT_CATEGORIES = ['charging', 'audio', 'protection'] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export const LOYALTY_TIERS = ['BRONZE', 'SILVER', 'GOLD'] as const;
export type LoyaltyTier = (typeof LOYALTY_TIERS)[number];

/** A shop location. */
export interface StoreRow extends RowMetadata {
  readonly name: string;
  readonly city: string;
  /** When the store stopped trading; `null` while it is open. */
  readonly closedAt: string | null;
}

/** A catalogue entry. What it costs, and how many there are, is per store. */
export interface ProductRow extends RowMetadata {
  /** Unique stock-keeping unit. */
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly category: ProductCategory;
  /** When it left the catalogue; `null` while it is sold. */
  readonly archivedAt: string | null;
}

/** A product on a store's shelf. Unique per (storeId, productId). */
export interface StoreProductRow extends RowMetadata {
  readonly storeId: string;
  readonly productId: string;
  /** Selling price at this store, in rupiah. */
  readonly price: number;
  /** Units on the shelf that no order has reserved yet. */
  readonly stock: number;
}

/** A shopper's profile. Credentials live apart, in `CredentialRow`. */
export interface CustomerRow extends RowMetadata {
  readonly name: string;
  /** Lower-cased, unique. */
  readonly email: string;
  readonly phone: string | null;
}

/** How a customer proves who they are. One per customer. */
export interface CredentialRow extends RowMetadata {
  readonly customerId: string;
  /** `scrypt$N$r$p$salt$hash` — never the password itself. */
  readonly passwordHash: string;
}

/** A signed-in session. The bearer token itself is never stored. */
export interface SessionRow extends RowMetadata {
  readonly customerId: string;
  /** SHA-256 of the bearer token, hex. Unique. */
  readonly tokenHash: string;
  readonly expiresAt: string;
}

/** A customer's loyalty points. One per customer, opened on first use. */
export interface LoyaltyAccountRow extends RowMetadata {
  readonly customerId: string;
  /** Points the customer can still spend. */
  readonly pointsBalance: number;
  /** Every point ever earned, spent or not; this is what sets the tier. */
  readonly lifetimePoints: number;
}

/** How much a voucher takes off. */
export type VoucherDiscount =
  | {
      readonly kind: 'PERCENTAGE';
      /** Whole percent of the order subtotal, 1–100. */
      readonly percent: number;
      /** Cap on the discount in rupiah; `null` for none. */
      readonly maxDiscount: number | null;
    }
  | {
      readonly kind: 'FIXED';
      /** Rupiah off the subtotal. */
      readonly amount: number;
    };

/** Who may use a voucher. */
export type VoucherAudience =
  | { readonly kind: 'PUBLIC' }
  | {
      readonly kind: 'PERSONAL';
      /** The only customer who may use it. */
      readonly customerId: string;
      /** The loyalty reward it was claimed from. */
      readonly rewardId: string;
    };

/** A discount code. Codes are upper-case and unique. */
export interface VoucherRow extends RowMetadata {
  readonly code: string;
  readonly title: string;
  readonly discount: VoucherDiscount;
  /** Smallest subtotal, in rupiah, the voucher applies to. */
  readonly minSpend: number;
  /** When it stops being valid; `null` when it never does. */
  readonly expiresAt: string | null;
  readonly audience: VoucherAudience;
}

/**
 * A voucher spent on a paid order. Unique per (voucherId, customerId): a
 * public voucher can be used once by each customer, and a personal voucher,
 * which only its owner may use, once in all.
 */
export interface VoucherRedemptionRow extends RowMetadata {
  readonly voucherId: string;
  readonly customerId: string;
  readonly orderId: string;
}

/** A voucher customers can buy with loyalty points. */
export interface RewardRow extends RowMetadata {
  readonly title: string;
  readonly pointsCost: number;
  readonly discount: VoucherDiscount;
  readonly minSpend: number;
  /** How long a voucher claimed from this reward stays valid. */
  readonly validForDays: number;
}

/** One product in an order, priced when the order was placed. */
export interface OrderLine {
  readonly productId: string;
  /** The product's name at checkout, so history survives a rename. */
  readonly productName: string;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly lineTotal: number;
}

/** How an order's total was reached, in rupiah. */
export interface OrderPricing {
  readonly subtotal: number;
  readonly voucherDiscount: number;
  readonly tierDiscount: number;
  /** `subtotal - voucherDiscount - tierDiscount`: what the customer pays. */
  readonly total: number;
}

/** The voucher an order was checked out with. */
export interface AppliedVoucher {
  readonly voucherId: string;
  readonly code: string;
}

interface OrderRowBase extends RowMetadata {
  readonly customerId: string;
  readonly storeId: string;
  readonly lines: readonly OrderLine[];
  readonly pricing: OrderPricing;
  readonly voucher: AppliedVoucher | null;
  /** The customer's tier at checkout, and the discount it gave. */
  readonly loyaltyTier: LoyaltyTier;
  readonly tierDiscountPercent: number;
}

/** Checked out, stock reserved, waiting for its bill to be paid. */
export interface PendingPaymentOrderRow extends OrderRowBase {
  readonly status: 'PENDING_PAYMENT';
}

/** Paid: the voucher is spent and the loyalty points are credited. */
export interface PaidOrderRow extends OrderRowBase {
  readonly status: 'PAID';
  readonly paidAt: string;
  readonly pointsEarned: number;
}

/** Cancelled before payment; its stock went back on the shelf. */
export interface CancelledOrderRow extends OrderRowBase {
  readonly status: 'CANCELLED';
  readonly cancelledAt: string;
  readonly cancelReason: string;
}

export type OrderRow =
  PendingPaymentOrderRow | PaidOrderRow | CancelledOrderRow;
export type OrderStatus = OrderRow['status'];

interface BillRowBase extends RowMetadata {
  /** The order this bill collects for. Unique: one bill per order. */
  readonly orderId: string;
  readonly customerId: string;
  /** Rupiah to collect: the order's total. */
  readonly amount: number;
  /**
   * The reference the payment gateway quotes back in its callback. It is
   * unguessable and unique, so knowing it stands in for the signature a real
   * gateway would put on its callback.
   */
  readonly gatewayReference: string;
}

export interface UnpaidBillRow extends BillRowBase {
  readonly status: 'UNPAID';
}

export interface PaidBillRow extends BillRowBase {
  readonly status: 'PAID';
  readonly paidAt: string;
}

export interface FailedBillRow extends BillRowBase {
  readonly status: 'FAILED';
  readonly failedAt: string;
  readonly failureReason: string;
}

/** Withdrawn because its order was cancelled before anyone paid. */
export interface VoidBillRow extends BillRowBase {
  readonly status: 'VOID';
  readonly voidedAt: string;
}

export type BillRow = UnpaidBillRow | PaidBillRow | FailedBillRow | VoidBillRow;
export type BillStatus = BillRow['status'];
