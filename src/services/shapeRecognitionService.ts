/**
 * Per-user auto-perfect preference (Month 4, Phase 9).
 *
 * Reads / writes the single `shapeRecognitionPref` field on the user doc,
 * mirroring the notificationPref seam in notificationService. The board screen
 * reads it once on mount (AuthContext does not hydrate it) and updates it from
 * the pen-tool toggle. Kept tiny and isolated so the geometry classifier stays
 * pure and the preference plumbing stays testable on its own.
 */

import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import { ShapeRecognitionMode } from "../types";
import { captureException } from "../lib/errorReporting";

/**
 * Default for a user with no `shapeRecognitionPref` on their doc (every account
 * pre-Phase-9, plus the field is optional): "ask" — recognition runs but never
 * mutates the stroke without a tap, the least surprising default.
 */
export const DEFAULT_SHAPE_RECOGNITION_MODE: ShapeRecognitionMode = "ask";

/** Reads a user's auto-perfect mode, defaulting when the field is absent. */
export async function getShapeRecognitionMode(
  userId: string
): Promise<ShapeRecognitionMode> {
  try {
    const snap = await getDoc(doc(db, "users", userId));
    const mode = snap.exists()
      ? (snap.data().shapeRecognitionPref as ShapeRecognitionMode | undefined)
      : undefined;
    return mode ?? DEFAULT_SHAPE_RECOGNITION_MODE;
  } catch (e) {
    captureException(e, { op: "getShapeRecognitionMode" });
    return DEFAULT_SHAPE_RECOGNITION_MODE;
  }
}

/** Persists a user's auto-perfect mode on their user doc. */
export async function setShapeRecognitionMode(
  userId: string,
  mode: ShapeRecognitionMode
): Promise<void> {
  await updateDoc(doc(db, "users", userId), { shapeRecognitionPref: mode });
}
