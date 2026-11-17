import type {
  BillRow,
  CredentialRow,
  CustomerRow,
  LoyaltyAccountRow,
  OrderRow,
  ProductRow,
  RewardRow,
  StoreProductRow,
  StoreRow,
  VoucherRow,
} from './database.schema';

/**
 * What the shop holds the moment it starts: three stores, six products and
 * their shelves, two public vouchers (and one that has expired), a reward
 * catalogue for loyalty points, and two customers with a few paid orders —
 * enough history for "frequently bought together" to answer from the start.
 *
 * DEMO ONLY: both seed customers sign in with the password
 * `shop-demo-password`. Only its scrypt hash is stored; it is published on
 * purpose so the demo can be explored, and is not a secret of any kind.
 */

function at(iso: string): { createdAt: string; updatedAt: string } {
  return { createdAt: iso, updatedAt: iso };
}

const OPENING_DAY = at('2026-01-05T08:00:00.000Z');

export const SEED_STORES: readonly StoreRow[] = [
  {
    id: 'str_1',
    ...OPENING_DAY,
    name: 'Jakarta Central',
    city: 'Jakarta',
    closedAt: null,
  },
  {
    id: 'str_2',
    ...OPENING_DAY,
    name: 'Bandung Dago',
    city: 'Bandung',
    closedAt: null,
  },
  {
    id: 'str_3',
    ...OPENING_DAY,
    name: 'Surabaya Tunjungan',
    city: 'Surabaya',
    closedAt: null,
  },
];

export const SEED_PRODUCTS: readonly ProductRow[] = [
  {
    id: 'prd_1',
    ...OPENING_DAY,
    sku: 'CBL-USBC-1M',
    name: 'USB-C Cable 1 m',
    description: 'Braided USB-C to USB-C cable, rated for 60 W.',
    category: 'charging',
    archivedAt: null,
  },
  {
    id: 'prd_2',
    ...OPENING_DAY,
    sku: 'CHG-20W',
    name: '20 W USB-C Charger',
    description: 'Compact wall charger with USB Power Delivery.',
    category: 'charging',
    archivedAt: null,
  },
  {
    id: 'prd_3',
    ...OPENING_DAY,
    sku: 'PWB-10K',
    name: 'Power Bank 10,000 mAh',
    description: 'Slim power bank with USB-C in and out.',
    category: 'charging',
    archivedAt: null,
  },
  {
    id: 'prd_4',
    ...OPENING_DAY,
    sku: 'AUD-TWS',
    name: 'Wireless Earbuds',
    description: 'True wireless earbuds with a charging case.',
    category: 'audio',
    archivedAt: null,
  },
  {
    id: 'prd_5',
    ...OPENING_DAY,
    sku: 'PRT-CASE',
    name: 'Phone Case',
    description: 'Shock-absorbing clear case.',
    category: 'protection',
    archivedAt: null,
  },
  {
    id: 'prd_6',
    ...OPENING_DAY,
    sku: 'PRT-GLASS',
    name: 'Tempered Glass Screen Protector',
    description: '9H tempered glass, pack of two.',
    category: 'protection',
    archivedAt: null,
  },
];

export const SEED_STORE_PRODUCTS: readonly StoreProductRow[] = [
  {
    id: 'stp_1',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_1',
    price: 49_000,
    stock: 120,
  },
  {
    id: 'stp_2',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_2',
    price: 149_000,
    stock: 40,
  },
  {
    id: 'stp_3',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_3',
    price: 299_000,
    stock: 25,
  },
  {
    id: 'stp_4',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_4',
    price: 399_000,
    stock: 15,
  },
  {
    id: 'stp_5',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_5',
    price: 79_000,
    stock: 60,
  },
  {
    id: 'stp_6',
    ...OPENING_DAY,
    storeId: 'str_1',
    productId: 'prd_6',
    price: 59_000,
    stock: 80,
  },
  {
    id: 'stp_7',
    ...OPENING_DAY,
    storeId: 'str_2',
    productId: 'prd_1',
    price: 45_000,
    stock: 50,
  },
  {
    id: 'stp_8',
    ...OPENING_DAY,
    storeId: 'str_2',
    productId: 'prd_2',
    price: 145_000,
    stock: 20,
  },
  {
    id: 'stp_9',
    ...OPENING_DAY,
    storeId: 'str_2',
    productId: 'prd_5',
    price: 75_000,
    stock: 30,
  },
  {
    id: 'stp_10',
    ...OPENING_DAY,
    storeId: 'str_2',
    productId: 'prd_6',
    price: 55_000,
    stock: 40,
  },
  {
    id: 'stp_11',
    ...OPENING_DAY,
    storeId: 'str_3',
    productId: 'prd_1',
    price: 49_000,
    stock: 35,
  },
  {
    id: 'stp_12',
    ...OPENING_DAY,
    storeId: 'str_3',
    productId: 'prd_3',
    price: 289_000,
    stock: 10,
  },
  {
    id: 'stp_13',
    ...OPENING_DAY,
    storeId: 'str_3',
    productId: 'prd_4',
    price: 389_000,
    stock: 8,
  },
];

export const SEED_CUSTOMERS: readonly CustomerRow[] = [
  {
    id: 'cus_1',
    ...OPENING_DAY,
    name: 'Budi Santoso',
    email: 'budi@example.com',
    phone: '+6281100000001',
  },
  {
    id: 'cus_2',
    ...OPENING_DAY,
    name: 'Siti Rahma',
    email: 'siti@example.com',
    phone: null,
  },
];

/** scrypt hashes of the demo-only password `shop-demo-password`. */
export const SEED_CREDENTIALS: readonly CredentialRow[] = [
  {
    id: 'crd_1',
    ...OPENING_DAY,
    customerId: 'cus_1',
    passwordHash:
      'scrypt$16384$8$1$hOHCvs5hzhkJd3ybk4ss0Q$yGR3fAR08jyLwxehrMc_zgA3WHW1LUj0l0zjzOGD6mNjadSKTznLb9yuUCy9DN69j78iPA19KHfdUE78bTfF9A',
  },
  {
    id: 'crd_2',
    ...OPENING_DAY,
    customerId: 'cus_2',
    passwordHash:
      'scrypt$16384$8$1$ytHWzbudqC9e8raXeyiREA$w35YjB-hkOWUtd4G_4nSFJG3yVi3BvRGw8FSEDxK95WpAxNZndrlxHq5SJrtwft35nGg18nMOuHAwyyhcwCpeg',
  },
];

export const SEED_LOYALTY_ACCOUNTS: readonly LoyaltyAccountRow[] = [
  {
    id: 'lya_1',
    ...OPENING_DAY,
    customerId: 'cus_1',
    pointsBalance: 420,
    lifetimePoints: 1_250,
  },
  {
    id: 'lya_2',
    ...OPENING_DAY,
    customerId: 'cus_2',
    pointsBalance: 900,
    lifetimePoints: 5_600,
  },
];

export const SEED_VOUCHERS: readonly VoucherRow[] = [
  {
    id: 'vch_1',
    ...OPENING_DAY,
    code: 'WELCOME10',
    title: '10% off your order, up to Rp 30.000',
    discount: { kind: 'PERCENTAGE', percent: 10, maxDiscount: 30_000 },
    minSpend: 100_000,
    expiresAt: null,
    audience: { kind: 'PUBLIC' },
  },
  {
    id: 'vch_2',
    ...OPENING_DAY,
    code: 'HEMAT25K',
    title: 'Rp 25.000 off orders from Rp 250.000',
    discount: { kind: 'FIXED', amount: 25_000 },
    minSpend: 250_000,
    expiresAt: '2030-12-31T16:59:59.000Z',
    audience: { kind: 'PUBLIC' },
  },
  {
    id: 'vch_3',
    ...OPENING_DAY,
    code: 'FLASH50K',
    title: 'Rp 50.000 off — flash sale, ended',
    discount: { kind: 'FIXED', amount: 50_000 },
    minSpend: 200_000,
    expiresAt: '2026-01-31T16:59:59.000Z',
    audience: { kind: 'PUBLIC' },
  },
];

export const SEED_REWARDS: readonly RewardRow[] = [
  {
    id: 'rwd_1',
    ...OPENING_DAY,
    title: 'Rp 20.000 voucher',
    pointsCost: 100,
    discount: { kind: 'FIXED', amount: 20_000 },
    minSpend: 100_000,
    validForDays: 30,
  },
  {
    id: 'rwd_2',
    ...OPENING_DAY,
    title: '15% voucher, up to Rp 50.000',
    pointsCost: 300,
    discount: { kind: 'PERCENTAGE', percent: 15, maxDiscount: 50_000 },
    minSpend: 150_000,
    validForDays: 30,
  },
  {
    id: 'rwd_3',
    ...OPENING_DAY,
    title: 'Rp 75.000 voucher',
    pointsCost: 700,
    discount: { kind: 'FIXED', amount: 75_000 },
    minSpend: 300_000,
    validForDays: 60,
  },
];

/**
 * Paid orders already in the books. Priced by the rules checkout uses: the
 * tier discount is taken off what is left after any voucher, rounded down,
 * and every Rp 1.000 paid earns one point.
 */
export const SEED_ORDERS: readonly OrderRow[] = [
  {
    id: 'ord_1',
    ...at('2026-02-03T03:15:00.000Z'),
    status: 'PAID',
    customerId: 'cus_1',
    storeId: 'str_1',
    lines: [
      {
        productId: 'prd_2',
        productName: '20 W USB-C Charger',
        unitPrice: 149_000,
        quantity: 1,
        lineTotal: 149_000,
      },
      {
        productId: 'prd_1',
        productName: 'USB-C Cable 1 m',
        unitPrice: 49_000,
        quantity: 1,
        lineTotal: 49_000,
      },
    ],
    pricing: {
      subtotal: 198_000,
      voucherDiscount: 0,
      tierDiscount: 9_900,
      total: 188_100,
    },
    voucher: null,
    loyaltyTier: 'SILVER',
    tierDiscountPercent: 5,
    paidAt: '2026-02-03T03:20:00.000Z',
    pointsEarned: 188,
  },
  {
    id: 'ord_2',
    ...at('2026-02-11T06:40:00.000Z'),
    status: 'PAID',
    customerId: 'cus_2',
    storeId: 'str_1',
    lines: [
      {
        productId: 'prd_2',
        productName: '20 W USB-C Charger',
        unitPrice: 149_000,
        quantity: 1,
        lineTotal: 149_000,
      },
      {
        productId: 'prd_1',
        productName: 'USB-C Cable 1 m',
        unitPrice: 49_000,
        quantity: 2,
        lineTotal: 98_000,
      },
      {
        productId: 'prd_3',
        productName: 'Power Bank 10,000 mAh',
        unitPrice: 299_000,
        quantity: 1,
        lineTotal: 299_000,
      },
    ],
    pricing: {
      subtotal: 546_000,
      voucherDiscount: 0,
      tierDiscount: 54_600,
      total: 491_400,
    },
    voucher: null,
    loyaltyTier: 'GOLD',
    tierDiscountPercent: 10,
    paidAt: '2026-02-11T06:44:00.000Z',
    pointsEarned: 491,
  },
  {
    id: 'ord_3',
    ...at('2026-02-20T09:05:00.000Z'),
    status: 'PAID',
    customerId: 'cus_2',
    storeId: 'str_2',
    lines: [
      {
        productId: 'prd_5',
        productName: 'Phone Case',
        unitPrice: 75_000,
        quantity: 1,
        lineTotal: 75_000,
      },
      {
        productId: 'prd_6',
        productName: 'Tempered Glass Screen Protector',
        unitPrice: 55_000,
        quantity: 1,
        lineTotal: 55_000,
      },
    ],
    pricing: {
      subtotal: 130_000,
      voucherDiscount: 0,
      tierDiscount: 13_000,
      total: 117_000,
    },
    voucher: null,
    loyaltyTier: 'GOLD',
    tierDiscountPercent: 10,
    paidAt: '2026-02-20T09:07:00.000Z',
    pointsEarned: 117,
  },
  {
    id: 'ord_4',
    ...at('2026-03-02T11:30:00.000Z'),
    status: 'PAID',
    customerId: 'cus_1',
    storeId: 'str_1',
    lines: [
      {
        productId: 'prd_5',
        productName: 'Phone Case',
        unitPrice: 79_000,
        quantity: 1,
        lineTotal: 79_000,
      },
      {
        productId: 'prd_6',
        productName: 'Tempered Glass Screen Protector',
        unitPrice: 59_000,
        quantity: 2,
        lineTotal: 118_000,
      },
      {
        productId: 'prd_1',
        productName: 'USB-C Cable 1 m',
        unitPrice: 49_000,
        quantity: 1,
        lineTotal: 49_000,
      },
    ],
    pricing: {
      subtotal: 246_000,
      voucherDiscount: 0,
      tierDiscount: 12_300,
      total: 233_700,
    },
    voucher: null,
    loyaltyTier: 'SILVER',
    tierDiscountPercent: 5,
    paidAt: '2026-03-02T11:34:00.000Z',
    pointsEarned: 233,
  },
  {
    id: 'ord_5',
    ...at('2026-03-09T07:50:00.000Z'),
    status: 'PAID',
    customerId: 'cus_2',
    storeId: 'str_3',
    lines: [
      {
        productId: 'prd_4',
        productName: 'Wireless Earbuds',
        unitPrice: 389_000,
        quantity: 1,
        lineTotal: 389_000,
      },
      {
        productId: 'prd_3',
        productName: 'Power Bank 10,000 mAh',
        unitPrice: 289_000,
        quantity: 1,
        lineTotal: 289_000,
      },
    ],
    pricing: {
      subtotal: 678_000,
      voucherDiscount: 0,
      tierDiscount: 67_800,
      total: 610_200,
    },
    voucher: null,
    loyaltyTier: 'GOLD',
    tierDiscountPercent: 10,
    paidAt: '2026-03-09T07:52:00.000Z',
    pointsEarned: 610,
  },
];

/** The bills the seed orders were paid through. */
export const SEED_BILLS: readonly BillRow[] = [
  {
    id: 'bil_1',
    ...at('2026-02-03T03:15:00.000Z'),
    status: 'PAID',
    orderId: 'ord_1',
    customerId: 'cus_1',
    amount: 188_100,
    gatewayReference: 'pg_q4Yc1rW8mB2tKx7N',
    paidAt: '2026-02-03T03:20:00.000Z',
  },
  {
    id: 'bil_2',
    ...at('2026-02-11T06:40:00.000Z'),
    status: 'PAID',
    orderId: 'ord_2',
    customerId: 'cus_2',
    amount: 491_400,
    gatewayReference: 'pg_Lr9Fz2Hc6Vd1Sa0P',
    paidAt: '2026-02-11T06:44:00.000Z',
  },
  {
    id: 'bil_3',
    ...at('2026-02-20T09:05:00.000Z'),
    status: 'PAID',
    orderId: 'ord_3',
    customerId: 'cus_2',
    amount: 117_000,
    gatewayReference: 'pg_e3Tn8Ub5Qw4Jy6Gk',
    paidAt: '2026-02-20T09:07:00.000Z',
  },
  {
    id: 'bil_4',
    ...at('2026-03-02T11:30:00.000Z'),
    status: 'PAID',
    orderId: 'ord_4',
    customerId: 'cus_1',
    amount: 233_700,
    gatewayReference: 'pg_Xs7Ao1Ri9Me2Dh5C',
    paidAt: '2026-03-02T11:34:00.000Z',
  },
  {
    id: 'bil_5',
    ...at('2026-03-09T07:50:00.000Z'),
    status: 'PAID',
    orderId: 'ord_5',
    customerId: 'cus_2',
    amount: 610_200,
    gatewayReference: 'pg_Bv2Kw6Nf3Zl8Ty4E',
    paidAt: '2026-03-09T07:52:00.000Z',
  },
];
