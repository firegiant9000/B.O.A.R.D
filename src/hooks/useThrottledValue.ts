import { useEffect, useRef, useState } from "react";

/**
 * Returns `value` updated at most once per `intervalMs`, on both the leading and
 * trailing edge.
 *
 * Used to drive viewport culling: re-evaluating which elements are on screen on
 * every pan/zoom frame is wasteful, but a plain trailing debounce would never
 * update *during* a continuous pan (the timer keeps resetting), so content
 * panned into view would stay unmounted until the gesture stopped. Throttling
 * commits intermediate positions ~20×/s while still landing on the final
 * resting viewport via the trailing edge.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastCommitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastCommitRef.current;
    if (elapsed >= intervalMs) {
      lastCommitRef.current = now;
      setThrottled(value);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        lastCommitRef.current = Date.now();
        setThrottled(value);
      }, intervalMs - elapsed);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, intervalMs]);

  return throttled;
}
