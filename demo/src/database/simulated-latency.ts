/**
 * The one place the demo pretends to talk to a real database.
 *
 * Every operation `InMemoryTable` performs awaits one of these round trips
 * before it touches a row, so a request that reads three rows takes three
 * round trips' worth of time, and a Direct Run trace shows where it went.
 */
export const SIMULATED_LATENCY_MS = { min: 100, max: 200 } as const;

/**
 * A whole number of milliseconds between `SIMULATED_LATENCY_MS.min` and
 * `SIMULATED_LATENCY_MS.max`, both included.
 *
 * @param random source of values in `[0, 1)`; `Math.random` unless a caller
 * needs the result pinned
 */
export function pickSimulatedLatencyMs(
  random: () => number = Math.random,
): number {
  const { min, max } = SIMULATED_LATENCY_MS;

  return min + Math.floor(random() * (max - min + 1));
}

/** Waits one simulated database round trip: 100–200 ms. */
export function simulateDatabaseLatency(): Promise<void> {
  const delayMs = pickSimulatedLatencyMs();

  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
