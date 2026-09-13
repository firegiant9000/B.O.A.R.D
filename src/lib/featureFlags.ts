// Build-time feature flags (read from EXPO_PUBLIC_* env, inlined by Expo at build
// time). Kept tiny and centralized so a cutover is one place to look.

/**
 * Month 4, Phase 1 — AI gateway cutover.
 *
 * When `true`, the client calls the `generateSummary` Cloud Function (no API key
 * on device). When `false` (the default), it uses the legacy direct-OpenAI path
 * with a client-held key. Default OFF so summaries keep working until the function
 * is deployed and verified in prod; flip to "1" via the build env to cut over.
 * Once prod is verified, the legacy path + key UI are removed and this flag retires.
 */
export const AI_GATEWAY_ENABLED =
  process.env.EXPO_PUBLIC_AI_GATEWAY === "1" ||
  process.env.EXPO_PUBLIC_AI_GATEWAY === "true";

/**
 * Month 4, Phase 10 — handwriting OCR.
 *
 * Gates the "recognize text" selection affordance and the `recognizeHandwriting`
 * callable. Default OFF until the OCR function is deployed and the Google Vision
 * key is set in Functions config; flip to "1" via the build env to expose it.
 * OCR rides the same Cloud Function gateway as summaries, so it is only meaningful
 * once `AI_GATEWAY_ENABLED` is also on.
 */
export const OCR_ENABLED =
  process.env.EXPO_PUBLIC_OCR === "1" || process.env.EXPO_PUBLIC_OCR === "true";

/**
 * Month 4, Phase 11 — explain selection.
 *
 * Gates the "explain this" selection affordance and the `explainSelection`
 * callable. Default OFF until the function is deployed; flip to "1" via the build
 * env to expose it. Like OCR it rides the Cloud Function gateway, so it is only
 * meaningful once `AI_GATEWAY_ENABLED` is also on.
 */
export const EXPLAIN_ENABLED =
  process.env.EXPO_PUBLIC_EXPLAIN === "1" ||
  process.env.EXPO_PUBLIC_EXPLAIN === "true";

/**
 * Month 4, Phase 12 — text → diagram.
 *
 * Gates the diagram-prompt affordance and the `textToDiagram` callable. Default
 * OFF until the function is deployed; flip to "1" via the build env to expose it.
 * Like OCR and explain it rides the Cloud Function gateway, so it is only
 * meaningful once `AI_GATEWAY_ENABLED` is also on.
 */
export const DIAGRAM_ENABLED =
  process.env.EXPO_PUBLIC_DIAGRAM === "1" ||
  process.env.EXPO_PUBLIC_DIAGRAM === "true";

/**
 * Month 6 — flashcard generation.
 *
 * Gates the "Make flashcards" selection affordance and the `generateFlashcards`
 * callable. Default OFF until the function is deployed; flip to "1" via the
 * build env to expose it. Rides the Cloud Function gateway like OCR/explain/
 * diagram, so it is only meaningful once `AI_GATEWAY_ENABLED` is also on. The
 * review screen and CSV export are NOT gated by this flag — reviewing/exporting
 * cards you already have needs no AI call and should keep working even with
 * generation switched off.
 */
export const FLASHCARDS_ENABLED =
  process.env.EXPO_PUBLIC_FLASHCARDS === "1" ||
  process.env.EXPO_PUBLIC_FLASHCARDS === "true";

/**
 * Month 6 — board Q&A (chat with your board).
 *
 * Gates the sidebar chat affordance and the `askBoard` callable. Default OFF
 * until the function is deployed; flip to "1" via the build env to expose it.
 * Rides the Cloud Function gateway like every other AI feature, so it is only
 * meaningful once `AI_GATEWAY_ENABLED` is also on.
 *
 * This flag hides the ENTRY POINT, nothing more — like every other flag here it
 * is inlined into the client bundle and therefore public and patchable. The
 * things that actually stop an unauthorized or over-quota question are the
 * callable's own membership check, rate bucket and plan gate, all server-side.
 */
export const BOARD_QA_ENABLED =
  process.env.EXPO_PUBLIC_BOARD_QA === "1" ||
  process.env.EXPO_PUBLIC_BOARD_QA === "true";

/**
 * Month 6 — math elements (LaTeX → SVG path data).
 *
 * Gates the toolbar's equation button and the `renderMath` callable. Default
 * OFF until the function is deployed; flip to "1" via the build env.
 *
 * UNLIKE every flag above, this one does NOT depend on `AI_GATEWAY_ENABLED`.
 * `renderMath` is not an AI feature: MathJax runs in-process, there is no
 * provider, no API key and no per-call spend, so it is neither gated by the
 * gateway cutover nor metered against the workspace's AI-call quota. Tying it
 * to that flag would make equations unavailable for a reason that has nothing
 * to do with them.
 *
 * Like every flag here it is inlined into the client bundle and therefore
 * public and patchable — it hides the ENTRY POINT, nothing more. What
 * actually stops an unauthorised or runaway caller is the callable's own
 * membership check and rate bucket, both server-side, plus firestore.rules on
 * the element documents themselves.
 */
export const MATH_ENABLED =
  process.env.EXPO_PUBLIC_MATH === "1" || process.env.EXPO_PUBLIC_MATH === "true";
