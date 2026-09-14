jest.mock("../../lib/imagePicker", () => ({
  pickAndPrepareImage: jest.fn(),
}));
jest.mock("../imageService", () => ({
  uploadImage: jest.fn(),
  updateImage: jest.fn(),
}));
jest.mock("../aiService", () => ({
  recognizeHandwriting: jest.fn(),
  isOcrConfigured: jest.fn(),
}));
jest.mock("../../lib/errorReporting", () => ({ captureException: jest.fn() }));

import { pickAndPrepareImage } from "../../lib/imagePicker";
import * as imageService from "../imageService";
import { recognizeHandwriting, isOcrConfigured } from "../aiService";
import { captureException } from "../../lib/errorReporting";
import { placementBox, PreparedImage } from "../../lib/images";
import * as scanService from "../scanService";

/**
 * Month 6 — camera capture + OCR (descoped scanner). Two behaviors this task's
 * brief names directly: capture produces an ordinary `ImageElement` (via the
 * existing `imageService.uploadImage` path), and OCR routes through the
 * existing `aiService.recognizeHandwriting` pipeline rather than a second call
 * site. Everything else here is what those two need to be meaningfully tested
 * (cancel/deny, OCR-disabled, OCR-failure isolation, empty-text).
 */

const pickAndPrepareImageMock = pickAndPrepareImage as jest.Mock;
const uploadImageMock = imageService.uploadImage as jest.Mock;
const updateImageMock = imageService.updateImage as jest.Mock;
const recognizeHandwritingMock = recognizeHandwriting as jest.Mock;
const isOcrConfiguredMock = isOcrConfigured as jest.Mock;
const captureExceptionMock = captureException as jest.Mock;

const fakeBlob = { size: 1234 } as unknown as Blob;

const prepared: PreparedImage = {
  full: { blob: fakeBlob, width: 800, height: 600 },
  thumbnail: { blob: fakeBlob, width: 256, height: 192 },
  naturalWidth: 3200,
  naturalHeight: 2400,
  alt: "photo.jpg",
};

const center = { x: 100, y: 200 };

/** Mirrors recapExport.test.ts's mockFileReader: a synchronous stand-in for
 *  the platform FileReader so `readAsDataURL` resolves without real async I/O. */
function mockFileReader(dataUrl: string) {
  (global as any).FileReader = class {
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL(_blob: unknown) {
      this.result = dataUrl;
      this.onloadend?.();
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFileReader("data:image/jpeg;base64,FAKE");
});

afterEach(() => {
  delete (global as any).FileReader;
});

describe("scanDocument — capture produces an ordinary ImageElement", () => {
  it("resolves null without touching the upload/OCR pipeline when the camera is canceled", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(null);

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(result).toBeNull();
    expect(uploadImageMock).not.toHaveBeenCalled();
    expect(recognizeHandwritingMock).not.toHaveBeenCalled();
  });

  it("uploads the capture through the existing image pipeline, aspect-fit-placed around the given center", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-123");
    isOcrConfiguredMock.mockReturnValue(false);

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(pickAndPrepareImageMock).toHaveBeenCalledWith("camera");
    const expectedBox = placementBox(prepared.naturalWidth, prepared.naturalHeight, center);
    expect(uploadImageMock).toHaveBeenCalledWith("board-1", "u1", prepared, {
      ...expectedBox,
      alt: prepared.alt,
    });
    // The id `uploadImage` (the existing element-creation path) resolved to is
    // exactly the id the capture reports back — no parallel/special-cased
    // element is created alongside it.
    expect(result).not.toBeNull();
    expect(result!.imageId).toBe("img-123");
  });
});

describe("scanDocument — OCR routes through the existing handwriting-OCR pipeline", () => {
  it("calls recognizeHandwriting with the captured image's data URL and writes the text onto the element's alt field", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-456");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockResolvedValueOnce({
      text: "Chapter 3: Photosynthesis",
      confidence: 0.92,
      source: "vision",
      cached: false,
    });

    const result = await scanService.scanDocument("board-1", "u1", center);

    // Same callable the stroke-selection OCR affordance calls — no bespoke
    // provider call for scanned images.
    expect(recognizeHandwritingMock).toHaveBeenCalledWith(
      "board-1",
      "data:image/jpeg;base64,FAKE",
      ["img-456"]
    );
    expect(updateImageMock).toHaveBeenCalledWith("board-1", "img-456", {
      alt: "Chapter 3: Photosynthesis",
    });
    expect(result!.ocr).toEqual({
      text: "Chapter 3: Photosynthesis",
      confidence: 0.92,
      cached: false,
    });
    expect(result!.ocrQuotaExceeded).toBe(false);
  });

  it("skips the OCR call entirely when OCR isn't configured (flag/gateway off)", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-789");
    isOcrConfiguredMock.mockReturnValue(false);

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(recognizeHandwritingMock).not.toHaveBeenCalled();
    expect(updateImageMock).not.toHaveBeenCalled();
    expect(result!.ocr).toBeNull();
    expect(result!.ocrQuotaExceeded).toBe(false);
  });

  it("does not write a caption when OCR found no legible text (recognizeHandwriting rejects)", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-999");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockRejectedValueOnce(
      new Error("No legible text was found in the selection.")
    );

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(updateImageMock).not.toHaveBeenCalled();
    expect(result!.ocr).toBeNull();
    // Not a quota denial — reported to Sentry, and NOT routed to the upsell.
    expect(result!.ocrQuotaExceeded).toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ op: "board.scanDocument.ocr" })
    );
  });

  it("still returns the recognized text even when writing it back onto the element's alt field fails", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-caption-fail");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockResolvedValueOnce({
      text: "Some text",
      confidence: 0.9,
      source: "vision",
      cached: false,
    });
    updateImageMock.mockRejectedValueOnce(new Error("network blip"));

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(result!.ocr).toEqual({ text: "Some text", confidence: 0.9, cached: false });
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ op: "board.scanDocument.caption" })
    );
  });

  it("still returns the uploaded imageId when OCR fails (a quota denial, say) — the capture is never undone by an OCR problem", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-quota");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockRejectedValueOnce(
      Object.assign(new Error("Your workspace has reached its AI usage limit."), {
        code: "functions/resource-exhausted",
      })
    );

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(result).toEqual({ imageId: "img-quota", ocr: null, ocrQuotaExceeded: true });
  });
});

describe("scanDocument — OCR quota denial routes to the shared upsell, not Sentry", () => {
  it("flags ocrQuotaExceeded and skips captureException for a resource-exhausted rejection", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-quota-2");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockRejectedValueOnce(
      Object.assign(new Error("Too many AI requests right now."), {
        code: "functions/resource-exhausted",
      })
    );

    const result = await scanService.scanDocument("board-1", "u1", center);

    // The upsell signal the caller (useBoardElements' scanDocument) routes to
    // `onQuotaExceeded` — the SAME denial `useBoardAI`'s "Recognize text"
    // shows the upsell for, per useBoardAI.ts's isQuotaDenial-first check.
    expect(result!.ocrQuotaExceeded).toBe(true);
    expect(result!.ocr).toBeNull();
    // A quota/rate denial is a normal business outcome, not an application
    // error: it must not be reported to Sentry (contrast the plain-Error
    // "no legible text" case above, which DOES report).
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("still writes no caption and does not undo the capture when the quota denial arrives", async () => {
    pickAndPrepareImageMock.mockResolvedValueOnce(prepared);
    uploadImageMock.mockResolvedValueOnce("img-quota-3");
    isOcrConfiguredMock.mockReturnValue(true);
    recognizeHandwritingMock.mockRejectedValueOnce(
      Object.assign(new Error("Monthly AI limit reached."), {
        code: "functions/resource-exhausted",
      })
    );

    const result = await scanService.scanDocument("board-1", "u1", center);

    expect(updateImageMock).not.toHaveBeenCalled();
    expect(result!.imageId).toBe("img-quota-3");
  });
});
