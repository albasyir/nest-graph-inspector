/** What to recommend alongside. */
export interface FrequentlyBoughtTogetherQuery {
  readonly productId: string;
  /** How many products to return, 1 to 10; 5 when left out. */
  readonly limit?: number;
}

/** A product that shared paid orders with the one asked about. */
export interface FrequentlyBoughtTogether {
  readonly productId: string;
  /** The name it was most recently sold under. */
  readonly productName: string;
  /** How many paid orders held both products. */
  readonly timesBoughtTogether: number;
}

export const DEFAULT_RECOMMENDATION_LIMIT = 5;
export const MAX_RECOMMENDATION_LIMIT = 10;
