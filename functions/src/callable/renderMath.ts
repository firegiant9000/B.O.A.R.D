import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  renderMath as renderMathToPath,
  MAX_LATEX_LENGTH,
  type MathRenderResult,
} from "../math/mathRender";
import { mathCacheKey, getCachedMath, putCachedMath } from "../math/mathCache";
import { consumeToken, type BucketConfig } from "../ai/rateLimit";
import { resolveBoardAccess } from "../lib/board";

// Month 6 — math elements. Turns LaTeX into flat SVG path data (MathJax's SVG
// output, flattened — see functions/src/math/mathRender.ts) so an equation is
// an ordinary `<Path>` on the canvas and therefore selectable, transformable,
// exportable and printable like every other element. Split into a pure,
// injectable `handleRenderMath(req, deps, now)` plus a thin `onCall` binding,
// the same shape as handleGenerateSummary/generateSummary and
// handleGenerateFlashcards/generateFlashcards.
//
// ── A MALFORMED EXPRESSION IS NOT AN ERROR CODE ────────────────────────────
// `\frac{` is a typo somebody is halfway through typing, not an exceptional
// condition. It comes back as a 200 carrying `{ error: "Missing close brace" }`
// — a throw here would surface on the client as a crash on every keystroke
// that passes through an incomplete expression. The throwing codes below are
// reserved for things that are genuinely NOT about the LaTeX: not signed in,
// not a member of the board, over the rate bucket.
//
// ── METERING: A RATE BUCKET, BUT NO PLAN QUOTA ─────────────────────────────
// This callable has NO PROVIDER COST. MathJax runs in-process; there is no
// per-call spend to meter, so it deliberately does NOT call `checkAiQuota`
// and does NOT call `recordAiUsage`. Typesetting an equation must not consume
// a workspace's AI-call allowance — a free workspace gets five interactive AI
// calls a period, and spending them on `x^2` would be indefensible.
//
// It IS rate-limited anyway, because "free" is not the same as "unbounded":
// this is compute a client can invoke in a loop, each call costing GB-seconds
// plus a Firestore transaction and one or two document operations, and TeX
// input is attacker-controlled enough that `maxMacros`/`maxBuffer` had to be
// pinned in the renderer. So it gets its OWN bucket under its OWN key
// (`math-…`) with its OWN, more generous config — the same "separate bucket
// because it fires at a different rate" reasoning askBoard uses, in the
// opposite direction. Sharing the default AI bucket would mean editing three
// equations in a row could deny the next summary, and vice versa.
//
// The one `resource-exhausted` throw below carries
// `details: { reason: "rate-limit" }`, like generateFlashcards and askBoard
// and unlike the four Month 4 callables — a client must be able to tell
// "retry in a moment" from "you must upgrade", and there is no plan-quota
// reason to confuse it with here at all.

/** 60 renders burst, refilling one per second. An equation is typeset once
 *  per committed edit, not per keystroke (see src/services/mathService.ts),
 *  so this is far above any human editing rate and far below what a loop
 *  would want. Deliberately looser than DEFAULT_BUCKET (30 @ 1/30s), which
 *  is sized for calls that cost money. */
const MATH_BUCKET: BucketConfig = { capacity: 60, refillPerSec: 1 };

export interface RenderMathRequest {
  boardId: string;
  latex: string;
  /** Display (block) vs inline typesetting. Defaults to display — an equation
   *  placed as its own canvas element is a block, not something running
   *  inside a line of prose. Part of the cache key: the two typeset
   *  differently (limits above vs beside a sum, for one). */
  displayMode?: boolean;
}

export interface RenderMathResponse {
  /** Flat SVG path data in board units at `scale: 1`. "" when `error` is set. */
  svgPath: string;
  width: number;
  height: number;
  /** True when served from `boards/{boardId}/mathCache` without re-rendering. */
  cached: boolean;
  /** Set exactly when the LaTeX could not be rendered. Readable as-is. */
  error?: string;
}

/** Injected so a test can count how many times the renderer actually ran —
 *  which is the only way to prove the cache does anything. */
export interface RenderMathDeps {
  render: (latex: string, displayMode: boolean) => Promise<MathRenderResult>;
}

export async function handleRenderMath(
  req: CallableRequest<RenderMathRequest>,
  deps: RenderMathDeps,
  now: number
): Promise<RenderMathResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to add an equation.");
  }

  const { boardId, latex, displayMode } = req.data ?? ({} as RenderMathRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }
  // Emptiness and length are checked HERE — before the board read AND before
  // `consumeToken` — as well as inside the renderer. Kept ahead of the bucket
  // deliberately: this is a request-shape check, not a metered action, and it
  // is the one branch in this function that touches neither Firestore nor the
  // renderer, so it costs nothing beyond the callable invocation itself.
  // That invocation is NOT free, though — this callable has no provider to
  // bill but is still loopable compute, same as the `uid`/`boardId` checks
  // above it, which are unmetered for the same structural reason: nothing can
  // be charged against a bucket before the caller and board are known. The
  // composer's own `maxLength` is an affordance, not a gate; this check (and
  // the rate bucket below it, once identity is known) is the real boundary.
  if (typeof latex !== "string" || latex.trim().length === 0) {
    return { svgPath: "", width: 0, height: 0, cached: false, error: "Enter an equation." };
  }
  if (latex.length > MAX_LATEX_LENGTH) {
    return {
      svgPath: "",
      width: 0,
      height: 0,
      cached: false,
      error: `That equation is too long (limit ${MAX_LATEX_LENGTH} characters).`,
    };
  }

  const db = getFirestore();

  const access = await resolveBoardAccess(db, boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  // The limiter runs BEFORE the cache read, which is the opposite order to
  // generateFlashcards/recognizeHandwriting. Those two short-circuit on a
  // cache hit because what their bucket protects is PROVIDER SPEND, and a hit
  // spends nothing. This bucket protects Firestore operations and function
  // compute, and a cache HIT still costs a document read — so letting hits
  // past the limiter would leave a loop of repeated identical requests
  // entirely unmetered. Bucketed per workspace; a legacy no-workspace board
  // falls back to a per-user key so a missing workspaceId cannot sidestep it.
  const bucketKey = `math-${access.workspaceId || `solo-${uid}`}`;
  const allowed = await consumeToken(db, bucketKey, now, MATH_BUCKET);
  if (!allowed) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many equations at once. Please wait a moment and try again.",
      // Always "rate-limit" here: this callable has no plan quota to exhaust,
      // so unlike generateFlashcards there is only ever one reason.
      { reason: "rate-limit" }
    );
  }

  const display = displayMode !== false;
  const key = mathCacheKey(latex, display);
  const cached = await getCachedMath(db, boardId, key);
  if (cached) {
    return {
      svgPath: cached.svgPath,
      width: cached.width,
      height: cached.height,
      cached: true,
    };
  }

  const result = await deps.render(latex, display);
  if (result.error) {
    // A refusal is NOT cached: the message can change with the renderer, and
    // an entry that says "no" is worth far less than the read it costs.
    return { svgPath: "", width: 0, height: 0, cached: false, error: result.error };
  }

  // A cache write must never fail a render the user is waiting on.
  try {
    await putCachedMath(db, boardId, key, {
      svgPath: result.svgPath,
      width: result.width,
      height: result.height,
      createdAt: now,
    });
  } catch (err) {
    logger.error("mathCache write failed", { boardId, err });
  }

  return {
    svgPath: result.svgPath,
    width: result.width,
    height: result.height,
    cached: false,
  };
}

export const renderMath_fn = onCall((req: CallableRequest<RenderMathRequest>) =>
  handleRenderMath(req, { render: renderMathToPath }, Date.now())
);
