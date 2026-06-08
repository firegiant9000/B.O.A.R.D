import { useSyncExternalStore } from "react";
import {
  subscribeConnectivity,
  getConnectivity,
  type ConnectivityState,
} from "../lib/connectivity";

/**
 * React binding for the connectivity store (Phase 6). Re-renders the subscriber
 * whenever online/pendingWrites changes. Server snapshot is the same as client,
 * so it is SSR-safe on web.
 */
export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(
    subscribeConnectivity,
    getConnectivity,
    getConnectivity
  );
}
