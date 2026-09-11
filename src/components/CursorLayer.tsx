import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { Viewport, boardToScreen } from "../lib/viewport";
import { CursorPresence } from "../types";
import { userColor } from "../lib/userColor";
import * as cursorService from "../services/cursorService";
import { activeTrail, appendPing, type LaserPing } from "../lib/laser";

/**
 * Live-cursor overlay (Month 4, Phase 6; Month 5 adds the laser trail). A
 * separate, non-interactive top layer that subscribes to the cursor side
 * channel itself — so remote cursor updates re-render only this component,
 * never the element tree (Appendix A.4 hard rule). Cursors are drawn in
 * screen space (converted from board space through the viewport) so labels
 * stay a constant size at any zoom.
 */

// ~12Hz repaint ceiling. Snapshot bursts are coalesced to this, latest-wins.
const RENDER_INTERVAL_MS = 80;

// Month 5 (laser pointer) — how often to force a repaint purely so an idle
// trail keeps fading/expiring on screen once its author stops sending new
// pings, rather than freezing on its last-received frame until some other
// cursor's write happens to trigger the next one. Independent of, and much
// finer-grained than, `RENDER_INTERVAL_MS`: this only ever runs while at
// least one trail is non-empty, and stops itself the moment none are (see
// the effect below) — an idle board with nobody laser-pointing pays nothing.
const LASER_TICK_MS = 100;

interface CursorLayerProps {
  boardId: string;
  viewport: Viewport;
  selfId?: string;
  blockedIds: string[];
}

export default function CursorLayer({
  boardId,
  viewport,
  selfId,
  blockedIds,
}: CursorLayerProps) {
  const [cursors, setCursors] = useState<CursorPresence[]>([]);
  // Coalesce a flurry of remote updates to RENDER_INTERVAL_MS: stash the latest
  // snapshot on the ref and flush it on a single trailing timer.
  const latestRef = useRef<CursorPresence[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!boardId) return;
    const unsub = cursorService.subscribeToCursors(boardId, (incoming) => {
      latestRef.current = incoming;
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCursors(latestRef.current);
      }, RENDER_INTERVAL_MS);
    });
    return () => {
      unsub();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [boardId]);

  // Month 5 (laser pointer) — reader-side trail accumulation. A cursor doc
  // holds at most one ping (`setDoc`'s full-document replace — see
  // `cursorService.ts#writerFor`), so the fading multi-point trail is built
  // here, across successive snapshot deliveries, via `appendPing`
  // (`src/lib/laser.ts`) rather than expected out of the payload itself.
  //
  // Computed synchronously during render — a ref updated in a guarded branch,
  // not inside a `useEffect` — because an effect only runs *after* the render
  // it was scheduled from commits. A second ping delivered while a trail is
  // already non-empty changes `cursors` but not the "is any trail active"
  // flag an effect could key off of, so an effect-based update would render
  // one frame stale (this render, right now, needs the ping it was just
  // handed, not next render's). This mirrors React's documented pattern for
  // deriving/caching something from a prop/state change in a ref: guard on
  // an identity check against the last-seen input so it runs at most once
  // per actual `cursors` update, not on every render.
  //
  // Keyed off the full `cursors` list (not the filtered `visible` one
  // computed below) so a trail survives a transient reason a user drops out
  // of `visible` (e.g. `blockedIds` changing) without losing its history —
  // rendering below simply looks a trail up only for the cursors it actually
  // draws. Entries for a user no longer present in `cursors` at all (they
  // disconnected — `removeCursor` deleted their doc) are naturally dropped
  // when this replaces the whole map each run.
  const trailsRef = useRef<Map<string, LaserPing[]>>(new Map());
  const lastCursorsRef = useRef<CursorPresence[] | null>(null);
  if (lastCursorsRef.current !== cursors) {
    lastCursorsRef.current = cursors;
    const mergeNow = Date.now();
    const next = new Map<string, LaserPing[]>();
    for (const c of cursors) {
      const prev = trailsRef.current.get(c.userId) ?? [];
      const merged = appendPing(prev, c.ping, mergeNow);
      if (merged.length > 0) next.set(c.userId, merged);
    }
    trailsRef.current = next;
  }
  const hasTrail = trailsRef.current.size > 0;

  // A trail fades purely with elapsed time, not with new data, so once one
  // exists this keeps the component repainting (at `LASER_TICK_MS`, much
  // finer than the ~12Hz cursor-render throttle above) until every point in
  // it has aged out of `activeTrail`'s window, then clears the (by then
  // stale) raw history so `hasTrail` goes false and this stops ticking,
  // rather than ticking forever once a board has ever seen a laser.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!hasTrail) return;
    const id = setInterval(() => {
      const now = Date.now();
      let anyLeft = false;
      for (const pings of trailsRef.current.values()) {
        if (activeTrail(pings, now).length > 0) {
          anyLeft = true;
          break;
        }
      }
      if (!anyLeft) trailsRef.current = new Map();
      forceTick((n) => n + 1);
    }, LASER_TICK_MS);
    return () => clearInterval(id);
  }, [hasTrail]);

  const visible = cursorService.visibleCursors(
    cursors,
    selfId,
    blockedIds,
    Date.now()
  );

  const now = Date.now();
  // Fix round 1 (Month 5) — the laser trail is the tool's *output*, not a
  // redundant pointer duplicate like the arrow below, so unlike `visible` it
  // keeps the viewer's own entry: press-and-hold vs. quick-tap otherwise
  // produce two results the pointing user can't tell apart, the fade gives
  // no feedback about what the audience currently sees, and on touch their
  // own finger already occludes the point. Never un-hide the self *cursor*
  // arrow, though — `visible` above stays exactly as it was.
  const trailEligible = cursorService.trailEligibleCursors(cursors, blockedIds, now);
  if (visible.length === 0 && trailEligible.length === 0) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* Month 5 — laser trails, one shared SVG layer under the cursor arrows.
          A UI affordance only: like every field on this ephemeral channel,
          nothing here is enforced by a Firestore rule — any client could
          claim to be laser-pointing, the same as it could fake a cursor
          position today. */}
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        {trailEligible.flatMap((c) => {
          const pings = trailsRef.current.get(c.userId);
          if (!pings || pings.length === 0) return [];
          const color = userColor(c.userId);
          return activeTrail(pings, now).map((pt) => {
            const s = boardToScreen(viewport, pt);
            return (
              <Circle
                key={`${c.userId}-${pt.t}`}
                cx={s.x}
                cy={s.y}
                r={6}
                fill={color}
                fillOpacity={pt.opacity}
              />
            );
          });
        })}
      </Svg>
      {visible.map((c) => {
        const p = boardToScreen(viewport, { x: c.x, y: c.y });
        const color = userColor(c.userId);
        return (
          <View
            key={c.userId}
            style={[styles.cursor, { transform: [{ translateX: p.x }, { translateY: p.y }] }]}
          >
            <Svg width={20} height={20} viewBox="0 0 20 20">
              {/* Classic arrow pointer. */}
              <Path
                d="M3 2 L3 15 L7 11 L10 17 L12.5 16 L9.5 10 L15 10 Z"
                fill={color}
                stroke="#ffffff"
                strokeWidth={1.2}
              />
            </Svg>
            <View style={[styles.label, { backgroundColor: color }]}>
              <Text style={styles.labelText} numberOfLines={1}>
                {c.displayName}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: "absolute",
    top: 0,
    left: 0,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  label: {
    marginLeft: 2,
    marginTop: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    maxWidth: 120,
  },
  labelText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "600",
  },
});
