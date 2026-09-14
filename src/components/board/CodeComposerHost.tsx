import React, { useCallback, useEffect, useState } from "react";
import CodeComposer from "./CodeComposer";
import type { CodeLanguage } from "../../types";

// Month 6 — code elements. Owns everything the code composer needs to
// BEHAVE: the in-flight flag, how a failure becomes a sentence, and when the
// sheet is allowed to close — mirrors MathComposerHost exactly, for the same
// reason: `app/board/[id].tsx` cannot be render- or import-tested in this
// Jest setup, and this is the part worth testing.
//
// The screen contributes only two booleans' worth of plumbing: whether the
// sheet is open, and which element (if any) is being edited.

export interface CodeComposerHostProps {
  visible: boolean;
  /** Element being edited, or null when inserting a new code block. */
  editingId?: string | null;
  /** That element's current source, or null when inserting. */
  initialCode?: string | null;
  /** That element's current language, or null when inserting. */
  initialLanguage?: CodeLanguage | null;
  /** Lay out and insert. Rejects on a write failure. */
  onCreate: (code: string, language: CodeLanguage) => Promise<unknown>;
  /** Re-lay-out an existing element. Rejects the same way — including the
   *  write-path guard for an element a collaborator deleted while the
   *  composer was open (`updateCodeSource`'s contract). */
  onUpdate: (elementId: string, code: string, language: CodeLanguage) => Promise<unknown>;
  /** Close the sheet (the screen clears its own open/editing state). */
  onClose: () => void;
}

/**
 * Turn a rejection from the write path into one line the user can act on.
 *
 * UNLIKE `mathErrorMessage`, there is no TeX-typo case and no metered
 * callable here at all — `codeService`'s header is explicit that neither
 * write path below can fail on the content itself, only on the Firestore
 * write (or the deleted-element guard). So there is nothing to re-derive a
 * per-code-path sentence for; the message is already the most useful thing
 * available, and is shown through as-is.
 */
export function codeErrorMessage(err: unknown): string {
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Couldn't save that code block.";
}

export default function CodeComposerHost({
  visible,
  editingId,
  initialCode,
  initialLanguage,
  onCreate,
  onUpdate,
  onClose,
}: CodeComposerHostProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reopened sheet must never show the previous attempt's failure.
  useEffect(() => {
    if (visible) setError(null);
  }, [visible, editingId]);

  const handleSubmit = useCallback(
    async (code: string, language: CodeLanguage) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        if (editingId) await onUpdate(editingId, code, language);
        else await onCreate(code, language);
        // Only a SUCCESS closes the sheet. On a failure it stays open with
        // the message inline, because closing would throw away what the
        // user typed at the exact moment they need to correct it (e.g. copy
        // it elsewhere before the element it referenced is gone for good).
        onClose();
      } catch (e) {
        setError(codeErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, editingId, onCreate, onUpdate, onClose]
  );

  const handleCancel = useCallback(() => {
    if (busy) return; // a write is in flight; the composer disables its own buttons too
    setError(null);
    onClose();
  }, [busy, onClose]);

  return (
    <CodeComposer
      visible={visible}
      editingId={editingId ?? null}
      initialCode={initialCode ?? null}
      initialLanguage={initialLanguage ?? null}
      busy={busy}
      error={error}
      onCancel={handleCancel}
      onSubmit={handleSubmit}
    />
  );
}
