import type { PurchasedBasket } from '../order/order.dto';
import type { FrequentlyBoughtTogether } from './recommendation.dto';

/**
 * Ranks what was bought alongside a product: every other product in a paid
 * order that held it — only those in `among`, when given — counted once per
 * order. Most frequent first, then by product id, so products with equal
 * counts always come out in one order. The limit applies last.
 */
export function rankFrequentlyBoughtTogether(input: {
  readonly baskets: readonly PurchasedBasket[];
  readonly productId: string;
  readonly limit: number;
  readonly among?: ReadonlySet<string>;
}): FrequentlyBoughtTogether[] {
  const counts = new Map<string, { productName: string; orders: number }>();

  for (const basket of input.baskets) {
    if (!basket.lines.some((line) => line.productId === input.productId)) {
      continue;
    }

    const others = new Map(
      basket.lines
        .filter((line) => line.productId !== input.productId)
        .map((line) => [line.productId, line.productName]),
    );

    for (const [productId, productName] of others) {
      if (input.among && !input.among.has(productId)) {
        continue;
      }

      // Baskets arrive oldest first, so the latest name wins.
      counts.set(productId, {
        productName,
        orders: (counts.get(productId)?.orders ?? 0) + 1,
      });
    }
  }

  return [...counts.entries()]
    .map(([productId, { productName, orders }]) => ({
      productId,
      productName,
      timesBoughtTogether: orders,
    }))
    .sort(
      (left, right) =>
        right.timesBoughtTogether - left.timesBoughtTogether ||
        left.productId.localeCompare(right.productId),
    )
    .slice(0, input.limit);
}
