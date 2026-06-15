import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { OpenAIProvider } from "../ai/openai";
import {
  buildDiagramMessages,
  extractMermaid,
  validateMermaid,
  DIAGRAM_MAX_TOKENS,
  type DiagramFamily,
} from "../ai/diagram";
import { consumeToken } from "../ai/rateLimit";
import { recordAiUsage, checkAiQuota } from "../ai/usage";
import { resolveBoardAccess } from "../lib/board";
import { OPENAI_API_KEY } from "../config";
import type { AIProvider } from "../ai/provider";

// Phase 12 "text → diagram" callable. Same skeleton as explainSelection (auth →
// board access → rate limit → quota → provider.chat → telemetry → return), with
// one addition: the model output is *validated* and, on failure, the model is
// retried exactly once with a stricter prompt (Appendix B.7). The function returns
// raw Mermaid syntax; the client (`src/lib/mermaid-to-board.ts`) parses it into
// native board elements. Like explain there is no cache — generation is creative,
// so re-running can legitimately differ and isn't worth memoizing.

const FEATURE = "diagram";

export interface TextToDiagramRequest {
  boardId: string;
  /** The natural-language description of the diagram to draw. */
  prompt: string;
}

export interface TextToDiagramResponse {
  /** Validated Mermaid source for the client parser. */
  mermaid: string;
  /** Detected diagram family (flowchart | sequence | class | mindmap). */
  family: DiagramFamily;
  model: string;
  /** True when the first reply failed validation and the stricter retry was used. */
  retried: boolean;
}

export async function handleTextToDiagram(
  req: CallableRequest<TextToDiagramRequest>,
  provider: AIProvider,
  now: number
): Promise<TextToDiagramResponse> {
  const uid = req.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to generate a diagram.");
  }

  const { boardId, prompt } = req.data ?? ({} as TextToDiagramRequest);
  if (!boardId) {
    throw new HttpsError("invalid-argument", "boardId is required.");
  }
  if (!prompt || !prompt.trim()) {
    throw new HttpsError("invalid-argument", "A prompt describing the diagram is required.");
  }

  const db = getFirestore();

  const access = await resolveBoardAccess(db, boardId, uid);
  if (!access) {
    throw new HttpsError("not-found", "Board not found.");
  }
  if (!access.isMember) {
    throw new HttpsError("permission-denied", "You are not a member of this board.");
  }

  // Rate-limit by workspace; legacy no-workspace boards bucket per-user so a
  // missing workspaceId can't sidestep the limiter. One token covers the whole
  // generate-and-maybe-retry attempt — the retry is the function's choice, not a
  // second user request, so it should not cost the user a second token.
  const bucketKey = access.workspaceId || `solo-${uid}`;
  const allowed = await consumeToken(db, bucketKey, now);
  if (!allowed) {
    throw new HttpsError(
      "resource-exhausted",
      "Too many AI requests right now. Please wait a moment and try again."
    );
  }

  if (access.workspaceId) {
    const withinQuota = await checkAiQuota(db, access.workspaceId, now);
    if (!withinQuota) {
      throw new HttpsError(
        "resource-exhausted",
        "Your workspace has reached its AI usage limit for this period."
      );
    }
  }

  // First attempt, then exactly one stricter retry on a parse failure. Both calls
  // are metered (each is a real paid completion); `retried` tells the client the
  // second one was used.
  let retried = false;
  let usageToLog: Awaited<ReturnType<AIProvider["chat"]>> | null = null;
  let mermaid = "";
  let family: DiagramFamily | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = buildDiagramMessages(prompt, attempt > 0);
    const chat = await provider.chat({
      model: "diagram-text",
      messages,
      maxTokens: DIAGRAM_MAX_TOKENS,
      // Low temperature: we want valid, parseable structure, not creative prose.
      temperature: 0.2,
    });

    // Telemetry is per paid call. Record each attempt so the retry's cost is not
    // hidden; the loop below logs them as it goes.
    await logUsage(db, access.workspaceId, uid, chat, now);
    usageToLog = chat;

    if (!chat.text) {
      retried = attempt > 0;
      continue;
    }

    const candidate = extractMermaid(chat.text);
    const validation = validateMermaid(candidate);
    if (validation.valid && validation.family) {
      mermaid = candidate;
      family = validation.family;
      retried = attempt > 0;
      break;
    }
    retried = attempt > 0;
  }

  if (!mermaid || !family) {
    throw new HttpsError(
      "internal",
      "Couldn't produce a valid diagram for that prompt. Try rephrasing it."
    );
  }

  return { mermaid, family, model: usageToLog?.model ?? "diagram-text", retried };
}

/** Phase 2 cost telemetry, fire-and-forget within the call. A telemetry write must
 *  never fail a diagram the user already paid for, so a failure is logged and
 *  swallowed. Solo/legacy boards have no workspace to meter under. */
async function logUsage(
  db: FirebaseFirestore.Firestore,
  workspaceId: string | undefined,
  uid: string,
  chat: Awaited<ReturnType<AIProvider["chat"]>>,
  now: number
): Promise<void> {
  if (!workspaceId) return;
  try {
    await recordAiUsage(db, {
      workspaceId,
      uid,
      feature: FEATURE,
      model: chat.model,
      usage: chat.usage,
      now,
    });
  } catch (err) {
    logger.error("aiUsage telemetry write failed", { feature: FEATURE, err });
  }
}

export const textToDiagram = onCall(
  { secrets: [OPENAI_API_KEY] },
  (req: CallableRequest<TextToDiagramRequest>) =>
    handleTextToDiagram(req, new OpenAIProvider(OPENAI_API_KEY.value()), Date.now())
);
