/**
 * Month 5 — laser pointer (Phase 6). Pure trail math, unit-testable without a
 * live cursor subscription — mirrors the style of `src/lib/presenter.ts`.
 *
 * A laser ping rides the same ephemeral cursor doc as everything else on
 * `CursorPayload` (`src/services/cursorService.ts`), and that doc is replaced
 * *whole* on every write (`setDoc`, no `{ merge: true }` — see the comment on
 * `writerFor` in that file), so at most one ping ever lives on disk at a
 * time. The multi-point fading trail this module computes is therefore built
 * reader-side: `src/components/CursorLayer.tsx` calls `appendPing` on every
 * cursor snapshot it receives to fold that author's latest ping into the
 * history it has personally observed, and `activeTrail` at render time to
 * prune + fade that history. Nothing in this module writes anything —
 * consistent with the rest of this file, the laser never touches Firestore,
 * on the reader side or otherwise.
 */

/** One sampled laser point, as broadcast on `CursorPayload.ping`. */
export interface LaserPing {
  /** Board-space x. */
  x: number;
  /** Board-space y. */
  y: number;
  /** Client epoch ms this point was sampled. */
  t: number;
}

/** A trail point annotated with its current fade opacity (1 → 0). */
export interface FadingLaserPoint extends LaserPing {
  opacity: number;
}

/**
 * How long a laser point stays visible after it's sampled, per the spec
 * ("fades after 2 seconds"). Deliberately independent of `CURSOR_STALE_MS`
 * (10s, `cursorService.ts`) — a trail always finishes fading long before its
 * author's cursor doc would ever be treated as stale, so the two windows are
 * never derived from one another.
 */
export const LASER_FADE_MS = 2000;

function age(ping: LaserPing, now: number): number {
  return now - ping.t;
}

function withinFadeWindow(ping: LaserPing, now: number): boolean {
  return age(ping, now) <= LASER_FADE_MS;
}

/**
 * The subset of `pings` still inside the fade window at `now`, each
 * annotated with a linear opacity from 1 (just sampled) to 0 (about to
 * expire). Pure and total: never mutates its input, never throws.
 */
export function activeTrail(pings: LaserPing[], now: number): FadingLaserPoint[] {
  return pings.filter((p) => withinFadeWindow(p, now)).map((p) => ({
    ...p,
    opacity: Math.max(0, Math.min(1, 1 - age(p, now) / LASER_FADE_MS)),
  }));
}

/**
 * Reader-side trail accumulation (see file header): folds one newly observed
 * ping into a trail already pruned to the fade window, so a caller never has
 * to reason about pruning and appending landing in the wrong order.
 *
 * `ping` is whatever the author's single cursor doc carries *this* delivery —
 * `null`/`undefined` when it currently has none (they aren't laser-pointing,
 * or the doc predates the laser). Because the doc holds at most one ping ever,
 * an unrelated cursor's write commonly redelivers this author's *unchanged*
 * latest ping too — `cursorService.ts`'s multiplexed listener fans out the
 * whole collection on any change, not just the doc that actually changed.
 * Comparing timestamps drops that redelivery instead of appending a
 * duplicate trail point at the same spot.
 */
export function appendPing(
  trail: LaserPing[],
  ping: LaserPing | null | undefined,
  now: number
): LaserPing[] {
  const pruned = trail.filter((p) => withinFadeWindow(p, now));
  if (!ping) return pruned;
  const last = pruned[pruned.length - 1];
  if (last && last.t === ping.t) return pruned;
  return [...pruned, ping];
}
