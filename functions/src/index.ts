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
