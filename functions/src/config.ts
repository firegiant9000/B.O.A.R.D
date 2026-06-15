import { defineSecret } from "firebase-functions/params";

// Provider secrets live in Functions runtime config, never in the client bundle
// (Phase 1's whole reason for existing). Set before first deploy:
//   firebase functions:secrets:set OPENAI_API_KEY
export const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// Google Cloud Vision API key (Month 4, Phase 10 — handwriting OCR). The OCR
// callable calls the Vision REST API key-first (cheapest) and only escalates to
// the OpenAI vision model on low confidence, so this key lives only in the
// function runtime. Enable the Cloud Vision API on the project, then set:
//   firebase functions:secrets:set GOOGLE_VISION_API_KEY
export const GOOGLE_VISION_API_KEY = defineSecret("GOOGLE_VISION_API_KEY");

// HS256 signing secret for embed tokens (Month 4, Phase 8). Lives only in the
// function runtime so a forged embed link can't be produced client-side. Set
// before first deploy:
//   firebase functions:secrets:set EMBED_JWT_SECRET
export const EMBED_JWT_SECRET = defineSecret("EMBED_JWT_SECRET");
