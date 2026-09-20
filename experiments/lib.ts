import { TypeSafeClient } from "@typesafe-ai/sdk";

export const MODEL = "jev-1.13.0";
export const PRICE_PER_MTOK = 0.042;

export function getClient(): TypeSafeClient {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set. Put it in brainstem/.env (bun auto-loads it).");
    process.exit(1);
  }
  return new TypeSafeClient();
}

export function stats(nums: number[]): { p50: number; p95: number; mean: number } {
  const s = [...nums].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { p50: at(0.5), p95: at(0.95), mean: nums.reduce((a, b) => a + b, 0) / nums.length };
}

export const costUsd = (tokens: number) => (tokens / 1e6) * PRICE_PER_MTOK;
export const pct = (n: number) => `${(100 * n).toFixed(1)}%`;

export async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
