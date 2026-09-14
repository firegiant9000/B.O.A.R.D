import { useCallback, useEffect, useRef, useState } from "react";
import type { UpsellResource, UpsellVariant } from "../components/upsellCopy";
import { recordUpsellAttempt } from "../services/upsellCadence";

// Owns the plan-limit modal's visibility AND how hard it pushes, for the board
// screen's six gate hits (two AI-call bridges, presenter, session, custom
// palette, board Q&A). Before this existed, each of those called
// `setUpsellResource(...)` directly and every one of them got the full sell,
// including a user's very first encounter with the gate — ROADMAP.md:608
// (item 14) requires restraint on that first contact.
//
// WHY THE CALL SITES GO THROUGH A HOOK RATHER THAN THE MODAL READING STORAGE
// ITSELF. The attempt count is an async read, and the modal mounts
// synchronously the moment a resource is set. If the modal did its own lookup,
// it would have to render SOMETHING for the frame before the count arrived —
// and rendering its default body for that frame would flash the cost figure
// and the purchase action at exactly the user this feature exists to spare,
// on a build where that content is not allowed to appear at all. Resolving
// here instead means `resource` only ever becomes non-null in the same state
// commit that sets the variant it was resolved for, so there is no such frame.
// The cost of that choice, stated honestly: the modal appears one storage read
// later than it used to. That read is a single AsyncStorage `getItem` on a
// path the user has just been denied on, not a hot loop.
//
// FAILS SOFT, NEVER CLOSED. `recordUpsellAttempt` already resolves "soft" for
// every storage error rather than rejecting; the `catch` below is belt and
// braces for a future edit that makes it throwable, and keeps a gate hit from
// ever surfacing as an unhandled rejection mid-denial. Note what failing soft
// does NOT mean: the notice still shows. A storage error makes the message
// gentler, never absent — a blocked action with no explanation reads as a bug,
// which is the outcome the literal reading of "skip on first attempt" was
// rejected for producing.

export interface UpsellCadenceState {
  /** The gate whose modal is showing, or null for none. Null hides it, the
   *  same convention `BoardModals` already used for `upsellResource`. */
  resource: UpsellResource | null;
  /** How hard to push for `resource`. Meaningless while `resource` is null,
   *  and "soft" there rather than "hard" so that even a caller that reads it
   *  out of turn gets the restrained answer. */
  variant: UpsellVariant;
  /** Record one encounter with `resource`'s gate and show the modal for it.
   *  Deliberately returns void, not a promise: the six call sites are event
   *  handlers on a denial path with nothing to await it. */
  show: (resource: UpsellResource) => void;
  /** Hide the modal. Clears the variant with it, so the next `show` can never
   *  be rendered against the previous gate's resolved push. */
  dismiss: () => void;
}

interface CadenceState {
  resource: UpsellResource | null;
  variant: UpsellVariant;
}

const HIDDEN: CadenceState = { resource: null, variant: "soft" };

export function useUpsellCadence(): UpsellCadenceState {
  // ONE state object, not two `useState`s. Two would be committed together by
  // React's batching today, but nothing would enforce that — and the failure
  // mode of them ever separating is a frame of the wrong body, which is the
  // precise thing this hook exists to prevent. Keeping them in one value makes
  // the invariant structural instead of incidental.
  const [state, setState] = useState<CadenceState>(HIDDEN);

  // The board screen can be navigated away from between a gate hit and the
  // stored count coming back (a user who was denied a board and immediately
  // went back). React 18+ no longer warns about a set-state on an unmounted
  // component, so this is not about silencing a warning — it is about not
  // resurrecting a modal onto a screen that is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = useCallback((resource: UpsellResource) => {
    void recordUpsellAttempt(resource)
      .catch((): UpsellVariant => "soft")
      .then((variant) => {
        if (mounted.current) setState({ resource, variant });
      });
  }, []);

  const dismiss = useCallback(() => setState(HIDDEN), []);

  return { resource: state.resource, variant: state.variant, show, dismiss };
}
