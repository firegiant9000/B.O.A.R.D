// Google Cloud Vision adapter (Month 4, Phase 10 — handwriting OCR). Called
// key-first because Vision's DOCUMENT_TEXT_DETECTION is an order of magnitude
// cheaper than a vision LLM; the OCR callable only escalates to the OpenAI vision
// model when Vision's confidence is low (see ocr.ts). Like AIProvider, this is an
// interface so the callable handler is unit-tested with a mock and never reaches
// the network.

/** What every OCR engine returns: the recognized text + a 0–1 confidence the
 *  caller compares against the escalation threshold. */
export interface VisionResult {
  text: string;
  /** 0–1. Vision reports per-page confidence; 0 when nothing was detected. */
  confidence: number;
}

/** The contract the OCR callable depends on (mirrors AIProvider). One impl today
 *  (Google Cloud Vision REST); a different OCR backend swaps in here. */
export interface VisionClient {
  detectHandwriting(imageDataUrl: string): Promise<VisionResult>;
}

// DOCUMENT_TEXT_DETECTION is tuned for dense/handwritten text (vs the sparser
// TEXT_DETECTION); it returns a `fullTextAnnotation` with per-page confidence.
const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

/** Strips the `data:image/...;base64,` prefix Vision doesn't want; passes a bare
 *  base64 string through unchanged. */
export function toBase64Content(imageDataUrl: string): string {
  const comma = imageDataUrl.indexOf(",");
  return imageDataUrl.startsWith("data:") && comma >= 0
    ? imageDataUrl.slice(comma + 1)
    : imageDataUrl;
}

/** Pure: pull the recognized text + a representative confidence out of a Vision
 *  `images:annotate` response body. Kept side-effect-free so it is unit-tested
 *  against canned response shapes. Averages the page confidences Vision reports
 *  (it has no single document-level score); empty/blank → confidence 0. */
export function parseVisionResponse(body: any): VisionResult {
  const annotation = body?.responses?.[0]?.fullTextAnnotation;
  const text: string = typeof annotation?.text === "string" ? annotation.text.trim() : "";
  if (!text) return { text: "", confidence: 0 };

  const pages: any[] = Array.isArray(annotation?.pages) ? annotation.pages : [];
  const scores = pages
    .map((p) => (typeof p?.confidence === "number" ? p.confidence : null))
    .filter((c): c is number => c !== null);
  const confidence =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return { text, confidence };
}

export class GoogleVisionClient implements VisionClient {
  constructor(private apiKey: string) {}

  async detectHandwriting(imageDataUrl: string): Promise<VisionResult> {
    const res = await fetch(`${VISION_ENDPOINT}?key=${this.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: toBase64Content(imageDataUrl) },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Vision API error (${res.status}): ${detail}`);
    }
    return parseVisionResponse(await res.json());
  }
}
