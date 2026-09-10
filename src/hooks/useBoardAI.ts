import { useState } from "react";
import { Bounds, Point } from "../lib/viewport";
import {
  recognizeHandwriting,
  isOcrConfigured,
  OCR_CONFIDENCE_THRESHOLD,
  explainSelection,
  isExplainConfigured,
  textToDiagram,
  isDiagramConfigured,
} from "../services/aiService";
import { mermaidToBoard, DiagramBuild, EmptyDiagramError } from "../lib/mermaid-to-board";
import { captureException } from "../lib/errorReporting";
import { isResourceExhausted } from "../services/quotaService";
import type { SelectionAnchor } from "./useSelection";

/**
 * The board's AI affordances (Month 5/6 Task 1 — extracted verbatim from
 * `app/board/[id].tsx`).
 *
 * Owns the three flag-gated selection affordances — handwriting OCR (Phase 10),
 * explain selection (Phase 11) and text → diagram (Phase 12) — plus their busy
 * gates and confirm prompts.
 *
 * The four flags behind them (`AI_GATEWAY_ENABLED`, `OCR_ENABLED`,
 * `EXPLAIN_ENABLED`, `DIAGRAM_ENABLED` in `src/lib/featureFlags.ts`) are read
 * through `aiService`'s `isOcrConfigured` / `isExplainConfigured` /
 * `isDiagramConfigured`, each of which requires the gateway flag *and* its own.
 * All four default OFF, so `ocrEnabled` / `explainEnabled` / `diagramEnabled` are
 * false unless the build env turns them on.
 *
 * Canvas capture and element creation arrive as bridge callbacks the screen
 * supplies, so this hook never reaches into the element model, the tool state, or
 * the viewport.
 */

/** The text element an AI affordance wants written; the bridge stamps identity + color. */
export interface BoardAITextSpec {
  text: string;
  position: Point;
  width: number;
  height: number;
  fontSize: number;
}

/** Everything the AI affordances need from the rest of the screen. */
export interface BoardAIBridge {
  /** Board-space union of the current selection, or null when nothing is selected. */
  selectionUnion: Bounds | null;
  /** Rasterize a board-space region to a data URL; null when capture fails. */
  captureRegion: (region: Bounds) => Promise<string | null>;
  /** Ids of the selected stroke paths — the OCR cache key. */
  selectedPathIds: () => string[];
  /** Transcribed text of the selected text elements + sticky notes. */
  selectionText: () => string;
  /** Board-space point the generated diagram should be centred on. */
  viewportCenter: () => Point;
  /** Persist one text element; resolves to its id. */
  createTextElement: (spec: BoardAITextSpec) => Promise<string>;
  /** Persist a parsed diagram at a board-space origin; resolves to every new id. */
  createDiagram: (build: DiagramBuild, ox: number, oy: number) => Promise<string[]>;
  /** Adopt new elements: switch to the select tool, select them, schedule a save. */
  adopt: (ids: string[], opts?: { anchor?: SelectionAnchor; edit?: boolean }) => void;
  /** Surface a user-facing failure in the screen's error banner. */
  onError: (message: string) => void;
  /** Task 11: an AI call was denied resource-exhausted (checkAiQuota, past the
   *  free plan's AI-call cap) — the screen should show the upsell instead of
   *  routing this through `onError`'s generic banner. */
  onQuotaExceeded: () => void;
}

/** A low-confidence OCR result held back behind a confirm step (Appendix B.7). */
export interface OcrCandidate {
  text: string;
  position: Point;
  confidence: number;
}

export interface BoardAI {
  /** Whether the "Recognize text" affordance should be offered. */
  ocrEnabled: boolean;
  /** Whether the "Explain this" affordance should be offered. */
  explainEnabled: boolean;
  /** Whether the text → diagram affordance should be offered. */
  diagramEnabled: boolean;

  // Handwriting OCR (Phase 10)
  ocrBusy: boolean;
  ocrCandidate: OcrCandidate | null;
  recognizeText: () => Promise<void>;
  acceptOcr: () => Promise<void>;
  dismissOcr: () => void;

  // Explain selection (Phase 11)
  explainBusy: boolean;
  explain: () => Promise<void>;

  // Text → diagram (Phase 12)
  diagramOpen: boolean;
  openDiagram: () => void;
  closeDiagram: () => void;
  diagramPrompt: string;
  setDiagramPrompt: (prompt: string) => void;
  diagramBusy: boolean;
  generateDiagram: () => Promise<void>;
}

export function useBoardAI(boardId: string, bridge: BoardAIBridge): BoardAI {
  // Phase 10 — handwriting OCR. `ocrBusy` gates the in-flight call (button spinner);
  // `ocrCandidate` holds a low-confidence (<70%) result pending a confirm step
  // (Appendix B.7) — the board-space position is where the text element lands.
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrCandidate, setOcrCandidate] = useState<OcrCandidate | null>(null);
  // Phase 11 — explain selection. Gates the in-flight call (button spinner).
  const [explainBusy, setExplainBusy] = useState(false);
  // Phase 12 — text → diagram. The prompt panel's open state + draft text, and an
  // in-flight gate for the generate call (spinner + disabled submit).
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [diagramPrompt, setDiagramPrompt] = useState("");
  const [diagramBusy, setDiagramBusy] = useState(false);

  // --- Phase 10: handwriting OCR (selection → text element) ---

  // Place the recognized text as a new TextElement at the selection's top-left
  // (board space), then select it so it can be edited/moved immediately.
  const placeOcrText = async (text: string, position: Point) => {
    const elId = await bridge.createTextElement({
      text,
      position,
      width: 240,
      height: 96,
      fontSize: 20,
    });
    bridge.adopt([elId], { edit: true });
  };

  // Capture the selected region → OCR via the Cloud Function → place the text.
  // Low-confidence results route through a confirm prompt instead of landing
  // directly (Appendix B.7). The selected stroke ids are the cache key, so a
  // re-run on the same selection is a free server-side cache hit.
  const recognizeText = async () => {
    if (ocrBusy) return;
    const u = bridge.selectionUnion;
    if (!u) return;
    const pathIds = bridge.selectedPathIds();
    setOcrBusy(true);
    try {
      const image = await bridge.captureRegion(u);
      if (!image) {
        bridge.onError("Couldn't capture the selection for OCR.");
        return;
      }
      const result = await recognizeHandwriting(boardId, image, pathIds);
      const position = { x: u.minX, y: u.minY };
      if (result.confidence < OCR_CONFIDENCE_THRESHOLD) {
        setOcrCandidate({ text: result.text, position, confidence: result.confidence });
      } else {
        await placeOcrText(result.text, position);
      }
    } catch (e: any) {
      // resource-exhausted is checkAiQuota's real AI-call-cap denial — show
      // the upsell instead of the generic error banner. Anything else
      // (network, not-found, ...) keeps the existing banner path.
      if (isResourceExhausted(e)) {
        bridge.onQuotaExceeded();
      } else {
        captureException(e, { op: "board.ocr" });
        bridge.onError(e?.message ?? "Couldn't recognize the handwriting.");
      }
    } finally {
      setOcrBusy(false);
    }
  };

  // Low-confidence confirm-prompt actions: accept commits the text; dismiss drops it.
  const acceptOcr = async () => {
    const c = ocrCandidate;
    setOcrCandidate(null);
    if (c) {
      try {
        await placeOcrText(c.text, c.position);
      } catch (e) {
        captureException(e, { op: "board.ocrAccept" });
        bridge.onError("Couldn't insert the recognized text.");
      }
    }
  };

  // --- Phase 11: explain selection (selection → AI → text element beside it) ---

  // Capture the selected region + any selected text → explain via the Cloud
  // Function → drop the structured explanation as a TextElement to the right of the
  // selection. Works on any selection (strokes / text / image / mix): the image
  // carries the visual signal and the text carries transcribed content.
  const explain = async () => {
    if (explainBusy) return;
    const u = bridge.selectionUnion;
    if (!u) return;
    setExplainBusy(true);
    try {
      const selectedText = bridge.selectionText();
      const image = await bridge.captureRegion(u);

      const { text } = await explainSelection(boardId, image ?? undefined, selectedText || undefined);

      // Place beside (to the right of) the selection so it doesn't cover it.
      const elId = await bridge.createTextElement({
        text,
        position: { x: u.maxX + 24, y: u.minY },
        width: 280,
        height: 180,
        fontSize: 16,
      });
      bridge.adopt([elId]);
    } catch (e: any) {
      if (isResourceExhausted(e)) {
        bridge.onQuotaExceeded();
      } else {
        captureException(e, { op: "board.explain" });
        bridge.onError(e?.message ?? "Couldn't explain the selection.");
      }
    } finally {
      setExplainBusy(false);
    }
  };

  // --- Phase 12: text → diagram (prompt → Mermaid → native shapes/text) ---

  // Send the prompt to the Cloud Function, parse the returned Mermaid into native
  // element specs (`mermaid-to-board`), then write them as real ShapeElement/
  // TextElement docs centered on the current viewport. Nodes inherit the active
  // color; edges are lines/arrows. The whole batch is then selected so the user
  // can move/tweak it as a unit.
  const generateDiagram = async () => {
    const prompt = diagramPrompt.trim();
    if (diagramBusy || !prompt) return;
    setDiagramBusy(true);
    try {
      const { mermaid } = await textToDiagram(boardId, prompt);
      const build = mermaidToBoard(mermaid);

      // Center the diagram on the viewport: translate diagram-local (0,0)-origin
      // coords so the diagram's center lands on the screen center in board space.
      const center = bridge.viewportCenter();
      const ox = center.x - build.width / 2;
      const oy = center.y - build.height / 2;

      const newIds = await bridge.createDiagram(build, ox, oy);

      bridge.adopt(newIds, { anchor: "region" });
      setDiagramOpen(false);
      setDiagramPrompt("");
    } catch (e: any) {
      if (isResourceExhausted(e)) {
        bridge.onQuotaExceeded();
      } else {
        captureException(e, { op: "board.diagram" });
        bridge.onError(
          e instanceof EmptyDiagramError
            ? "The AI couldn't turn that into a diagram. Try rephrasing it."
            : e?.message ?? "Couldn't generate the diagram."
        );
      }
    } finally {
      setDiagramBusy(false);
    }
  };

  return {
    ocrEnabled: isOcrConfigured(),
    explainEnabled: isExplainConfigured(),
    diagramEnabled: isDiagramConfigured(),

    ocrBusy,
    ocrCandidate,
    recognizeText,
    acceptOcr,
    dismissOcr: () => setOcrCandidate(null),

    explainBusy,
    explain,

    diagramOpen,
    openDiagram: () => setDiagramOpen(true),
    closeDiagram: () => {
      if (!diagramBusy) setDiagramOpen(false);
    },
    diagramPrompt,
    setDiagramPrompt,
    diagramBusy,
    generateDiagram,
  };
}
