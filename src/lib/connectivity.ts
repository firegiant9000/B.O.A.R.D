/**
 * Connectivity store (Phase 6 — offline resilience).
 *
 * A dependency-free, cross-platform signal for "are we online / do we have writes
 * still syncing", consumed by the offline banner. Two sources feed it:
 *
 *  - Web: `navigator.onLine` + the `online`/`offline` window events — a direct OS
 *    signal that avoids the brief `fromCache` flashes a fresh listener can emit.
 *  - Native: there is no `navigator.onLine`, so we derive reachability from
 *    Firestore snapshot metadata (`fromCache`). A listener served `fromCache` after
 *    it has already reached the backend once means the client lost the connection.
 *
 * We deliberately avoid @react-native-community/netinfo (a new native dependency);
 * Firestore's own metadata already tells us what the banner needs and works the
 * same in every environment.
 */
import { Platform } from "react-native";

export type ConnectivityState = {
  /** False when the client can't reach the Firestore backend. */
  online: boolean;
  /** True while local writes have not yet been acknowledged by the server. */
  pendingWrites: boolean;
};

let state: ConnectivityState = { online: true, pendingWrites: false };
const listeners = new Set<() => void>();
let started = false;
// Native only: don't trust `fromCache` as an offline signal until we've reached
// the server at least once, so a cold load served from cache doesn't flash the
// offline banner before the first server round-trip lands.
let syncedFromServer = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<ConnectivityState>): void {
  const next = { ...state, ...patch };
  if (next.online === state.online && next.pendingWrites === state.pendingWrites) {
    return;
  }
  state = next;
  emit();
}

/** Current connectivity snapshot (stable reference until it changes). */
export function getConnectivity(): ConnectivityState {
  return state;
}

/** Subscribe to connectivity changes; returns an unsubscribe fn. */
export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Wire web `online`/`offline` events. Idempotent and a no-op on native (where the
 * signal comes from `reportSyncState`). Call once at app startup.
 */
export function initConnectivity(): void {
  if (started) return;
  started = true;
  if (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    typeof navigator !== "undefined"
  ) {
    setState({ online: navigator.onLine });
    window.addEventListener("online", () => setState({ online: true }));
    window.addEventListener("offline", () => setState({ online: false }));
  }
}

/**
 * Feed Firestore snapshot metadata in (from a listener opened with
 * `includeMetadataChanges`). Drives `pendingWrites` everywhere, and `online` on
 * native (web trusts `navigator.onLine` instead).
 */
export function reportSyncState(meta: {
  fromCache: boolean;
  hasPendingWrites: boolean;
}): void {
  if (!meta.fromCache) syncedFromServer = true;
  const patch: Partial<ConnectivityState> = {
    pendingWrites: meta.hasPendingWrites,
  };
  if (Platform.OS !== "web" && syncedFromServer) {
    patch.online = !meta.fromCache;
  }
  setState(patch);
}

/** Test-only: reset module state between cases. */
export function __resetConnectivityForTests(): void {
  state = { online: true, pendingWrites: false };
  listeners.clear();
  started = false;
  syncedFromServer = false;
}
