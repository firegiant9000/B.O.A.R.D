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

// Stripe (Month 5). Secret key + webhook signing secret live only in the function
// runtime. Set before first deploy:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
export const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// The Pro price ID. Not a secret, but server-resolved so a client can never
// choose the price it checks out at.
export const STRIPE_PRO_PRICE_ID = defineSecret("STRIPE_PRO_PRICE_ID");
