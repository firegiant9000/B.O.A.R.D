import type { Firestore } from "firebase-admin/firestore";
import type { BoardContent } from "../ai/summaryPrompt";

// Server-side board reads via the Admin SDK (which bypasses security rules — so we
// enforce membership ourselves here, the function's trust boundary). The client no
// longer gathers board content for AI; it passes only a boardId and the function
// resolves the rest, so a caller can't smuggle in content from a board they can't see.

export interface BoardAccess {
  /** The board's workspace, or "" for a legacy no-workspace board. */
  workspaceId: string;
  /** Whether `uid` is a member of the board. */
  isMember: boolean;
}

export async function resolveBoardAccess(
  db: Firestore,
  boardId: string,
  uid: string
): Promise<BoardAccess | null> {
  const snap = await db.doc(`boards/${boardId}`).get();
  if (!snap.exists) return null;
  const data = snap.data() as { members?: string[]; workspaceId?: string };
  const members = Array.isArray(data.members) ? data.members : [];
  return {
    workspaceId: data.workspaceId ?? "",
    isMember: members.includes(uid),
  };
}

/** Reads sticky notes + text elements for the AI prompt. Mirrors the client's
 *  pathService field shapes (notes.content, textElements.text). */
export async function gatherBoardContent(
  db: Firestore,
  boardId: string
): Promise<BoardContent> {
  const [notesSnap, textSnap] = await Promise.all([
    db.collection(`boards/${boardId}/notes`).get(),
    db.collection(`boards/${boardId}/textElements`).get(),
  ]);

  const notes = notesSnap.docs
    .map((d) => (d.data() as { content?: string }).content)
    .filter((c): c is string => typeof c === "string" && c.length > 0);

  const textElements = textSnap.docs
    .map((d) => (d.data() as { text?: string }).text)
    .filter((t): t is string => typeof t === "string");

  return { notes, textElements };
}
