import { applyBucket, type BucketConfig } from "../ai/rateLimit";

const cfg: BucketConfig = { capacity: 3, refillPerSec: 1 }; // 1 token/sec, cap 3

describe("applyBucket", () => {
  it("starts full and consumes one token on first use", () => {
    const { allowed, next } = applyBucket(undefined, 1000, cfg);
    expect(allowed).toBe(true);
    expect(next.tokens).toBeCloseTo(2);
  });

  it("denies when the bucket is empty and no time has passed", () => {
    const empty = { tokens: 0.5, updatedAt: 1000 };
    const { allowed, next } = applyBucket(empty, 1000, cfg);
    expect(allowed).toBe(false);
    expect(next.tokens).toBeCloseTo(0.5);
  });

  it("refills over elapsed time and then allows", () => {
    const empty = { tokens: 0, updatedAt: 1000 };
    // 2 seconds later → 2 tokens accrued
    const { allowed, next } = applyBucket(empty, 3000, cfg);
    expect(allowed).toBe(true);
    expect(next.tokens).toBeCloseTo(1);
  });

  it("never refills past capacity", () => {
    const stale = { tokens: 0, updatedAt: 0 };
    // a very long gap would accrue far more than capacity
    const { allowed, next } = applyBucket(stale, 1_000_000, cfg);
    expect(allowed).toBe(true);
    // capacity 3, consume 1 → 2
    expect(next.tokens).toBeCloseTo(2);
  });
});
