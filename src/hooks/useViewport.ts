import { useCallback, useEffect, useRef, useState } from "react";
import {
  Viewport,
  Point,
  Bounds,
  IDENTITY_VIEWPORT,
  panBy as panByPure,
  zoomAtPoint as zoomAtPointPure,
  zoomToScale as zoomToScalePure,
  fitToBounds,
} from "../lib/viewport";

const FLING_FRICTION = 0.92; // velocity decay per frame
const FLING_MIN_SPEED = 0.05; // px/ms — below this, stop the inertia loop

export interface ViewportController {
  viewport: Viewport;
  panBy: (dx: number, dy: number) => void;
  zoomAtPoint: (factor: number, focal: Point) => void;
  zoomToScale: (scale: number, focal: Point) => void;
  reset: () => void;
  fit: (content: Bounds | null, size: { width: number; height: number }) => void;
  /** Start inertial panning from a release velocity (screen px/ms). */
  fling: (vx: number, vy: number) => void;
  /** Cancel any in-flight inertia (e.g. on a new touch down). */
  stopFling: () => void;
}

export function useViewport(initial: Viewport = IDENTITY_VIEWPORT): ViewportController {
  const [viewport, setViewport] = useState<Viewport>(initial);
  const rafRef = useRef<number | null>(null);

  const stopFling = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => stopFling, [stopFling]);

  const panBy = useCallback((dx: number, dy: number) => {
    setViewport((vp) => panByPure(vp, dx, dy));
  }, []);

  const zoomAtPoint = useCallback((factor: number, focal: Point) => {
    setViewport((vp) => zoomAtPointPure(vp, factor, focal));
  }, []);

  const zoomToScale = useCallback((scale: number, focal: Point) => {
    setViewport((vp) => zoomToScalePure(vp, scale, focal));
  }, []);

  const reset = useCallback(() => {
    stopFling();
    setViewport(IDENTITY_VIEWPORT);
  }, [stopFling]);

  const fit = useCallback(
    (content: Bounds | null, size: { width: number; height: number }) => {
      stopFling();
      setViewport(fitToBounds(content, size));
    },
    [stopFling]
  );

  const fling = useCallback(
    (vx: number, vy: number) => {
      stopFling();
      let velX = vx;
      let velY = vy;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(now - last, 32); // clamp long frames
        last = now;
        velX *= FLING_FRICTION;
        velY *= FLING_FRICTION;
        setViewport((vp) => panByPure(vp, velX * dt, velY * dt));
        if (Math.hypot(velX, velY) > FLING_MIN_SPEED) {
          rafRef.current = requestAnimationFrame(step);
        } else {
          rafRef.current = null;
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [stopFling]
  );

  return { viewport, panBy, zoomAtPoint, zoomToScale, reset, fit, fling, stopFling };
}
