import type { Firestore } from "firebase-admin/firestore";

// Per-workspace token-bucket rate limiter at the function boundary (Phase 1
// scope). The pure refill/consume math lives in `applyBucket` so it is unit-tested
// without Firestore; `consumeToken` wraps it in a transaction as the persistence
// backstop. M5 turns the *plan* into a hard cap; this only protects the free tier
// from a runaway client (the roadmap "quota leak = cost spike" risk).

export interface BucketState {
  /** Whole tokens available (fractional accrual tracked separately on refill). */
  tokens: number;
  /** Epoch ms of the last refill, used to accrue tokens since. */
  updatedAt: number;
}

export interface BucketConfig {
  /** Maximum tokens the bucket holds. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export const DEFAULT_BUCKET: BucketConfig = {
  // 30 AI calls burst, refilling 1 every 30s (~120/hour sustained per workspace).
  capacity: 30,
  refillPerSec: 1 / 30,
};

export interface BucketDecision {
  allowed: boolean;
  next: BucketState;
}

/** Pure: given the current bucket, refill for elapsed time then try to consume
 *  one token. Returns the decision and the next state to persist. */
export function applyBucket(
  state: BucketState | undefined,
  now: number,
  config: BucketConfig = DEFAULT_BUCKET
): BucketDecision {
  const prev: BucketState = state ?? { tokens: config.capacity, updatedAt: now };
  const elapsedSec = Math.max(0, (now - prev.updatedAt) / 1000);
  const refilled = Math.min(
    config.capacity,
    prev.tokens + elapsedSec * config.refillPerSec
  );

  if (refilled >= 1) {
    return { allowed: true, next: { tokens: refilled - 1, updatedAt: now } };
  }
  return { allowed: false, next: { tokens: refilled, updatedAt: now } };
}

/** Transactional wrapper. `bucketKey` is the workspaceId (or a solo fallback for
 *  legacy no-workspace boards). Resolves true if a token was consumed. */
export async function consumeToken(
  db: Firestore,
  bucketKey: string,
  now: number,
  config: BucketConfig = DEFAULT_BUCKET
): Promise<boolean> {
  const ref = db.doc(`workspaces/${bucketKey}/aiRate/bucket`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const state = snap.exists ? (snap.data() as BucketState) : undefined;
    const { allowed, next } = applyBucket(state, now, config);
    tx.set(ref, next);
    return allowed;
  });
}
