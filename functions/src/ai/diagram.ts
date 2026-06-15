import type { ChatMessage } from "./provider";

// Pure prompt assembly + Mermaid extraction/validation for "text → diagram"
// (Month 4, Phase 12). Kept pure (no Firestore, no network) so it is unit-tested
// without an emulator — mirroring summaryPrompt/explain/ocr. The function only
// produces *Mermaid syntax*; the client (`src/lib/mermaid-to-board.ts`) is what
// turns that into native ShapeElement/TextElement nodes, so this module's job is
// just to coax a clean, single Mermaid block out of the model and reject garbage
// before it reaches the parser.

/** Output cap. A diagram is structure, not prose, so a few hundred tokens of
 *  Mermaid covers the v1 families comfortably while keeping the call cheap/fast. */
export const DIAGRAM_MAX_TOKENS = 700;

/** The five diagram families v1 supports (Appendix A.2 / the phase contract).
 *  `network` is not a native Mermaid type — it is drawn with the `graph`/
 *  `flowchart` grammar, so it shares the flowchart header detection below. */
export type DiagramFamily =
  | "flowchart"
  | "sequence"
  | "class"
  | "mindmap"
  | "network";

const SYSTEM_PROMPT = `You convert a natural-language request into a single Mermaid diagram.
Respond with ONLY the Mermaid source — no markdown code fences, no prose, no explanation before or after.
Use exactly one diagram and pick the most fitting type from this allowed set ONLY:
- "flowchart TD" or "flowchart LR" (also for simple network/topology diagrams)
- "sequenceDiagram"
- "classDiagram"
- "mindmap"
Rules:
- The first non-empty line MUST declare the diagram type from the set above.
- Keep node/participant/class labels short (a few words).
- Do not use styling directives, click handlers, subgraphs, or HTML.
- Prefer the simplest structure that answers the request.`;

const STRICTER_SUFFIX = `
Your previous reply could not be parsed as a valid Mermaid diagram.
Return ONLY raw Mermaid source. The FIRST line must be one of exactly:
"flowchart TD", "flowchart LR", "sequenceDiagram", "classDiagram", or "mindmap".
No code fences, no commentary, no styling — just the diagram.`;

/** Assembles the message list. `stricter` appends a harder instruction used for
 *  the single retry after a parse failure (Appendix B.7: validate, retry once). */
export function buildDiagramMessages(prompt: string, stricter = false): ChatMessage[] {
  const system = stricter ? SYSTEM_PROMPT + STRICTER_SUFFIX : SYSTEM_PROMPT;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Create a diagram for this request:\n\n${prompt.trim()}\n\nReturn only the Mermaid source.`,
    },
  ];
}

/** Strips markdown code fences and surrounding prose, returning the Mermaid body.
 *  Tolerates ```mermaid fences and stray leading/trailing lines. */
export function extractMermaid(text: string): string {
  let body = text.trim();
  // Pull the contents of a fenced block if one is present (```mermaid … ``` or ``` … ```).
  const fence = body.match(/```(?:mermaid)?\s*\n?([\s\S]*?)```/i);
  if (fence) {
    body = fence[1];
  }
  return body.trim();
}

/** Detects the diagram family from the header line, or null if it is not one of
 *  the five v1 families. `graph`/`flowchart` both map to flowchart; a bare
 *  `graph` is also how a "network" diagram is expressed, so the family is
 *  reported as `flowchart` and the client parser handles both identically. */
export function detectFamily(mermaid: string): DiagramFamily | null {
  const firstLine =
    mermaid
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const head = firstLine.toLowerCase();
  if (head.startsWith("flowchart") || head.startsWith("graph")) return "flowchart";
  if (head.startsWith("sequencediagram")) return "sequence";
  if (head.startsWith("classdiagram")) return "class";
  if (head.startsWith("mindmap")) return "mindmap";
  return null;
}

export interface DiagramValidation {
  valid: boolean;
  family: DiagramFamily | null;
  /** Human-readable reason when `valid` is false (for logs / the error surfaced). */
  error?: string;
}

/** Light syntactic validation — enough to reject prose, empty replies, unknown
 *  diagram types, and headers with no body. The authoritative parse (into board
 *  elements) happens client-side; this gate exists to drive the single stricter
 *  retry before a clearly-bad reply is handed back. */
export function validateMermaid(mermaid: string): DiagramValidation {
  const trimmed = mermaid.trim();
  if (!trimmed) {
    return { valid: false, family: null, error: "Empty diagram." };
  }
  const family = detectFamily(trimmed);
  if (!family) {
    return {
      valid: false,
      family: null,
      error: "Unrecognized diagram type (expected one of the five v1 families).",
    };
  }
  // Require at least one line of body beyond the header so a lone "flowchart TD"
  // (a header the model sometimes emits with no nodes) is treated as a failure.
  const bodyLines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(1);
  if (bodyLines.length === 0) {
    return { valid: false, family, error: "Diagram has a header but no content." };
  }
  return { valid: true, family };
}
