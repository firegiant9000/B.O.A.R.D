import { pickAndPrepareImage } from "../lib/imagePicker";
import { placementBox, PreparedImage } from "../lib/images";
import type { Point } from "../lib/viewport";
import * as imageService from "./imageService";
import { recognizeHandwriting, isOcrConfigured } from "./aiService";
import { isQuotaDenial } from "./quotaService";
import { captureException } from "../lib/errorReporting";

/**
 * Month 6 — camera capture + OCR (descoped scanner; see ROADMAP.md's Month 6
 * camera item). The spec named `expo-document-scanner`, a package that was
 * never published, and there is no drop-in replacement: ML Kit's document
 * scanner is Android-only, iOS needs VisionKit separately, and a wrapper
 * covering both needs a config plugin + an EAS build — none of which run in
 * Expo Go. True auto-edge-detection is Month 7 polish, not this task.
 *
 * Descoped to capture + crop(-less) + OCR, which still delivers "snap a
 * textbook page, drop it on the board, AI explains it" with zero new native
 * dependencies, by reusing two already-shipped pieces instead of adding one:
 *
 *   1. `expo-image-picker`'s camera launch (`lib/imagePicker.ts`, already a
 *      dependency, already wired for gallery/camera image inserts).
 *   2. The handwriting-OCR callable (`aiService.recognizeHandwriting`) — the
 *      SAME metered, cached pipeline every other OCR call on this board goes
 *      through, not a second call site with its own quota/rate logic.
 */

/** OCR outcome for a scanned photo, mirroring `aiService.OcrResult` minus the
 *  engine label (the caller has no use for it here). */
export interface ScanOcrResult {
  text: string;
  confidence: number;
  cached: boolean;
}

export interface ScanDocumentResult {
  /** Id of the ordinary `ImageElement` the capture created. It behaves like
   *  any other image on the board — selection, transform, export, delete all
   *  just work, because nothing about the write path is special-cased. */
  imageId: string;
  /** Recognized text, or null when OCR is unconfigured (flag off / gateway
   *  off) or the call failed (quota, network, no legible text). A failed OCR
   *  never undoes or blocks the capture — the photo the user just took is
   *  the primary artifact. */
  ocr: ScanOcrResult | null;
  /** True when `ocr` is null SPECIFICALLY because the OCR call was denied
   *  `resource-exhausted` (`quotaService.isQuotaDenial` — the AI-call quota
   *  or the workspace rate throttle; the server doesn't distinguish them).
   *  The caller routes this through the same upsell `useBoardAI`'s
   *  "Recognize text" shows for the identical denial, instead of the generic
   *  error banner. False for every other reason OCR produced no text. */
  ocrQuotaExceeded: boolean;
}

/** Convert a Blob to a base64 data URL for the OCR callable's JSON payload.
 *  FileReader behaves identically on web and React Native (see
 *  `utils/recapExport.ts`'s `fetchImageAsDataUri`, the same conversion for
 *  fetched bytes), so this needs no platform split of its own. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read the captured image."));
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

/** `runOcr`'s outcome: the recognized text (if any) plus whether the reason
 *  it's missing was specifically a quota/rate denial — the one OCR failure
 *  `scanDocument`'s caller should surface, as the shared upsell rather than
 *  silence or a Sentry report. */
interface OcrOutcome {
  ocr: ScanOcrResult | null;
  quotaExceeded: boolean;
}

/**
 * Runs OCR on a just-captured photo, isolated from capture/upload: a
 * disabled flag, an undeployed function, a quota denial, or a network error
 * all leave `ocr: null` here rather than losing the photo the user just
 * took. Not exported — always reached through `scanDocument`.
 */
async function runOcr(
  boardId: string,
  imageId: string,
  prepared: PreparedImage
): Promise<OcrOutcome> {
  if (!isOcrConfigured()) return { ocr: null, quotaExceeded: false };
  try {
    const dataUrl = await blobToDataUrl(prepared.full.blob);
    // A scanned photo has no strokes to key the OCR cache on. The new image's
    // own id (unique, stable, already the Firestore doc id) stands in for the
    // stroke-id list `recognizeHandwriting` hashes for its cache key, so a
    // re-run against this exact scan is still a free cache hit — the same
    // memoization stroke selections already get, just keyed on the image
    // instead of a set of path ids.
    const result = await recognizeHandwriting(boardId, dataUrl, [imageId]);
    return {
      ocr: { text: result.text, confidence: result.confidence, cached: result.cached },
      quotaExceeded: false,
    };
  } catch (e) {
    // A resource-exhausted denial (the AI-call quota or the workspace rate
    // throttle) is a normal, expected business outcome — NOT reported to
    // Sentry — and is classified BEFORE the generic catch-all, mirroring
    // `useBoardAI.ts`'s `recognizeText` (`isQuotaDenial(e)` checked first,
    // routed to `bridge.onQuotaExceeded()`, never `captureException`'d).
    // Every other failure (network, no legible text, ...) still reports.
    if (isQuotaDenial(e)) {
      return { ocr: null, quotaExceeded: true };
    }
    captureException(e, { op: "board.scanDocument.ocr" });
    return { ocr: null, quotaExceeded: false };
  }
}

/**
 * Opens the camera, uploads the shot as an ordinary `ImageElement` via the
 * existing image pipeline (`imageService.uploadImage` — the identical path
 * gallery inserts, clipboard paste, and duplicate all use), then runs OCR on
 * it through the existing handwriting-OCR callable. Resolves to `null` when
 * the user cancels the camera or denies permission (same contract as
 * `pickAndPrepareImage`).
 *
 * Recognized text (when any came back) is written onto the new element's own
 * `alt` field via `imageService.updateImage` — an ordinary, already-existing
 * field — rather than a new document or a special-cased element kind, so a
 * scanned page stays a completely ordinary image and its text rides along
 * with whatever already reads `alt` (search, accessibility).
 *
 * `center` is the board-space point the capture is aspect-fit-placed around
 * (the caller supplies the current viewport center, exactly like the
 * existing image-insert path).
 *
 * A resource-exhausted OCR denial is reported back via
 * `ScanDocumentResult.ocrQuotaExceeded` rather than swallowed or thrown, so
 * the caller can show the same upsell every other OCR-gated affordance
 * shows for the identical denial — see that field's own doc comment.
 */
export async function scanDocument(
  boardId: string,
  userId: string,
  center: Point
): Promise<ScanDocumentResult | null> {
  const prepared = await pickAndPrepareImage("camera");
  if (!prepared) return null;

  const box = placementBox(prepared.naturalWidth, prepared.naturalHeight, center);
  const imageId = await imageService.uploadImage(boardId, userId, prepared, {
    ...box,
    alt: prepared.alt,
  });

  const { ocr, quotaExceeded } = await runOcr(boardId, imageId, prepared);
  if (ocr && ocr.text) {
    try {
      await imageService.updateImage(boardId, imageId, { alt: ocr.text });
    } catch (e) {
      // The image already landed; a failed caption write isn't fatal.
      captureException(e, { op: "board.scanDocument.caption" });
    }
  }

  return { imageId, ocr, ocrQuotaExceeded: quotaExceeded };
}
