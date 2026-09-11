import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";

// Single Admin SDK init for the whole functions package; every module reads
// getFirestore() off this default app.
initializeApp();

// Min instances 0 on the free/Blaze tier — cold starts accepted for v1 (roadmap),
// the client surfaces a "summarizing…" state. Region pinned for predictable
// latency + so the client callable resolves the same region.
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

export { generateSummary } from "./callable/generateSummary";

// Month 4, Phase 10 — handwriting OCR. Region image (client-cropped) → Google
// Vision, escalating to the OpenAI vision model on low confidence; the result is
// memoized per selection so a re-run is free.
export { recognizeHandwriting } from "./callable/recognizeHandwriting";

// Month 4, Phase 11 — explain selection. Selection image + transcribed text →
// gpt-4o-mini → a compact concept/explanation/example block placed beside the
// selection as a TextElement. No cache (generative); rides the same gateway.
export { explainSelection } from "./callable/explainSelection";

// Month 4, Phase 12 — text → diagram. A natural-language prompt → gpt-4o-mini →
// validated Mermaid syntax (one stricter retry on a parse failure); the client
// parses it into native ShapeElement/TextElement nodes. No cache (generative).
export { textToDiagram } from "./callable/textToDiagram";

// Month 4, Phase 8 — embeddable boards. Mint a signed embed token (member-only)
// and exchange it for a scoped, read-only Firebase identity (unauthenticated).
// Exported names match the client callable names in src/services/embedService.ts.
export { mintEmbedToken_fn as mintEmbedToken } from "./callable/mintEmbedToken";
export { exchangeEmbedToken_fn as exchangeEmbedToken } from "./callable/exchangeEmbedToken";

// Month 5 — plan enforcement. Board creation is server-side: this is the ONLY
// way to create a board, since firestore.rules denies client board creates
// outright. The free-tier board cap holds on that plus one more rule — those
// rules also pin a board's `workspaceId` on update, without which a client could
// hide its boards from this function's per-workspace count (see the header of
// callable/createBoard.ts). Must be deployed BEFORE those rules — see the
// warning at the top of firestore.rules.
export { createBoard } from "./callable/createBoard";

// Month 5 — plan enforcement. Session creation is server-side: this is the ONLY
// way to create a session, since firestore.rules denies client session creates
// outright, so neither the free-tier monthly session cap nor the server-generated
// join code can be bypassed. Sessions are metered with a transactional monthly
// counter rather than a live count (functions/src/billing/usage.ts), since a
// session is never freed the way a deleted board is. Same deploy-order
// requirement as createBoard above.
export { createSession } from "./callable/createSession";

// Month 5 — starts a Stripe Checkout session for a workspace's Pro upgrade.
// The Pro price is resolved server-side from the STRIPE_PRO_PRICE_ID secret;
// the request carries no price field, so a client can't choose what it pays.
// There is no Stripe account behind this yet, so this has not been exercised
// against the real Checkout API — see functions/src/billing/stripe.ts.
export { createCheckoutSession } from "./callable/createCheckoutSession";

// Month 5/6 — mints a Stripe Customer Portal session, where a workspace owner
// cancels their subscription or changes their payment method. This app builds
// no cancellation UI of its own; the portal is that UI. Needs a Stripe
// customer id, which the webhook stamps onto `workspaces/{id}/billing/
// subscription.stripeCustomerId` on every applied event (see the header of
// callable/createPortalSession.ts). Same "no Stripe account behind this yet"
// caveat as createCheckoutSession above — the real portal redirect has not
// been exercised.
export { createPortalSession } from "./callable/createPortalSession";

// Month 5 — the Stripe webhook (POST /stripeWebhook). Turns a Stripe
// subscription's lifecycle into `workspaces/{id}.plan`, and is the only writer
// of that field after signup: firestore.rules denies `plan` on every client
// update and permits only 'free' on create, so the plan gates cannot be
// self-granted. Upgrades on a subscription becoming active, returns the
// workspace to 'free' on cancellation, expiry or exhausted payment retries,
// and dedupes Stripe's redeliveries on `event.id` — the plan write and that
// dedupe record share one transaction so they cannot diverge.
//
// This endpoint is unauthenticated by necessity (Stripe carries no Google
// identity); the HMAC signature over the request's raw bytes is what
// authenticates a caller. Nothing is registered on the Stripe side yet and
// STRIPE_WEBHOOK_SECRET does not exist, so until an endpoint is registered and
// its signing secret set, this answers 500 "not configured" — it has never
// received a delivery from Stripe. See functions/src/http/stripeWebhook.ts.
export { stripeWebhook } from "./http/stripeWebhook";

// Month 6 — anonymous-poll tallies. Maintains a server-side vote count at
// boards/{boardId}/polls/{pollId}/tally/summary on every write (create/
// update/delete) to a poll's votes subcollection — the ONLY way an anonymous
// poll (whose votes subcollection firestore.rules denies members from
// reading, even via count()) can compute or show a result at all. Skips
// non-anonymous polls entirely (they count the member-readable votes
// subcollection client-side instead). See functions/src/triggers/
// pollTally.ts for the eventual-consistency caveat.
export { onPollVoteWritten } from "./triggers/pollTally";
