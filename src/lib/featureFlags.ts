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
