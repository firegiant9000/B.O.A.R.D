import React, { useCallback, useEffect, useState } from "react";
import MathComposer from "./MathComposer";
import { resourceExhaustedReason, isResourceExhausted } from "../../services/quotaService";

// Month 6 — math elements. Owns everything the equation composer needs to
// BEHAVE: the in-flight flag, how a failure becomes a sentence, and when the
// sheet is allowed to close. Deliberately a component under src/components/
// rather than state in app/board/[id].tsx — a screen there cannot be render-
// or import-tested in this Jest setup, and this logic (which failures keep
// the sheet open, which message each one produces) is exactly the part worth
// testing.
//
// The screen contributes only two booleans' worth of plumbing: whether the
// sheet is open, and which element (if any) is being edited.

export interface MathComposerHostProps {
  visible: boolean;
  /** Element being edited, or null when inserting a new equation. */
  editingId?: string | null;
  /** That element's current LaTeX — what the field is seeded with. */
  initialLatex?: string | null;
  /** Typeset and insert. Rejects with a readable message on a TeX error. */
  onCreate: (latex: string) => Promise<unknown>;
  /** Re-typeset an existing element. Rejects the same way. */
  onUpdate: (elementId: string, latex: string) => Promise<unknown>;
  /** Close the sheet (the screen clears its own open/editing state). */
  onClose: () => void;
}

/**
 * Turn a rejection from the render path into one line the user can act on.
 *
 * A TeX error arrives as a plain Error with NO `code` — `mathService.renderMath`
 * is explicit about that split — and its message is already the most useful
 * thing anyone could say ("Missing close brace"), so it is shown verbatim.
 * The callable's real failures do carry a `code`, and each gets a sentence
 * that says what to do instead.
 */
export function mathErrorMessage(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (isResourceExhausted(err)) {
    // This callable has NO plan quota — MathJax runs in-process with no
    // provider cost, so its only `resource-exhausted` reason is the transient
    // rate bucket. "Upgrade" would be the wrong prompt here, and the server
    // says so explicitly via details.reason rather than leaving us to infer
    // it from the workspace's plan.
    const reason = resourceExhaustedReason(err);
    return reason === "plan-quota"
      ? "Your workspace has reached its limit for this period."
      : "Too many equations at once — wait a moment and try again.";
  }
  if (code === "functions/permission-denied" || code === "functions/unauthenticated") {
    return "You don't have permission to add equations to this board.";
  }
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Couldn't render that equation.";
}

export default function MathComposerHost({
  visible,
  editingId,
  initialLatex,
  onCreate,
  onUpdate,
  onClose,
}: MathComposerHostProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reopened sheet must never show the previous attempt's failure.
  useEffect(() => {
    if (visible) setError(null);
  }, [visible, editingId]);

  const handleSubmit = useCallback(
    async (latex: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        if (editingId) await onUpdate(editingId, latex);
        else await onCreate(latex);
        // Only a SUCCESS closes the sheet. On a TeX error it stays open with
        // the message inline, because closing would throw away what the user
        // typed at the exact moment they need to correct it.
        onClose();
      } catch (e) {
        setError(mathErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, editingId, onCreate, onUpdate, onClose]
  );

  const handleCancel = useCallback(() => {
    if (busy) return; // a render is in flight; the composer disables its own buttons too
    setError(null);
    onClose();
  }, [busy, onClose]);

  return (
    <MathComposer
      visible={visible}
      editingId={editingId ?? null}
      initialLatex={initialLatex ?? null}
      busy={busy}
      error={error}
      onCancel={handleCancel}
      onSubmit={handleSubmit}
    />
  );
}
