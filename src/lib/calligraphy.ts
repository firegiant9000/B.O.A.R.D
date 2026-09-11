import { Point } from "./viewport";

/**
 * Variable-width "calligraphy" stroke geometry (ROADMAP item 12 — "width
 * responds to direction"). SVG's `stroke-width` is constant along a whole
 * `<Path>`, so a direction-responsive nib can't be a stroked path the way
 * pen/highlighter/marker are — it has to be a FILLED shape whose outline
 * already has the width baked in. This module builds that outline as an SVG
 * path `d` string: one quadrilateral per segment (width set by that
 * segment's own direction against a fixed nib angle) plus a filled circle at
 * every joint to hide the seam between two differently-wide quads — the same
 * "capsule chain" a round linecap/linejoin gives a constant-width stroke for
 * free, done by hand here since that native join can't vary per segment.
 *
 * Pure geometry, no react-native-svg import, so this unit-tests without it
 * and without a renderer at all — `DrawingCanvas.tsx` is the only caller,
 * wrapping the result in a single `<Path fill=... stroke="none" d=.../>`.
 */

// A classic flat-nib calligraphy pen held at 45°: strokes running
// perpendicular to the nib (i.e. at 45°+90°) are widest, strokes running
// parallel to it are narrowest.
const NIB_ANGLE = Math.PI / 4;

function widthForAngle(theta: number, minWidth: number, maxWidth: number): number {
  return minWidth + (maxWidth - minWidth) * Math.abs(Math.cos(theta - NIB_ANGLE));
}

/** A filled circle, as a standalone two-arc subpath `d` fragment. Used both
 *  for a single-point stroke (a dot) and for the round joints between quads. */
function circleD(cx: number, cy: number, r: number): string {
  if (!(r > 0)) return "";
  return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
}

/**
 * Builds the combined `d` attribute for a calligraphy stroke through
 * `points` (board-space, already-simplified — same input DrawingCanvas
 * passes to `pointsToSvgPath` for a normal stroke). `minWidth`/`maxWidth`
 * are the nib's half-width band at its narrowest/widest orientation (see
 * `src/lib/penStyles.ts#calligraphyWidthRange`).
 *
 * Never throws: an empty point list yields `""` (the same "nothing to draw"
 * contract `pointsToSvgPath` uses), and a single point yields one dot at
 * `maxWidth` (there is no direction to narrow it from).
 */
export function calligraphyPathD(points: Point[], minWidth: number, maxWidth: number): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return circleD(points[0].x, points[0].y, maxWidth / 2);
  }

  const parts: string[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const theta = Math.atan2(dy, dx);
    const w = widthForAngle(theta, minWidth, maxWidth);
    // Unit normal, scaled to the half-width, so the quad's two long edges
    // run parallel to the segment, offset +/- w/2 to either side of it.
    const nx = (-dy / len) * (w / 2);
    const ny = (dx / len) * (w / 2);
    parts.push(
      `M ${a.x + nx} ${a.y + ny} L ${b.x + nx} ${b.y + ny} L ${b.x - nx} ${b.y - ny} L ${a.x - nx} ${a.y - ny} Z`
    );
    // Round the trailing joint of every segment but the last (the last
    // point's cap is added once, below) so two adjacent quads of differing
    // width never show a visible notch where they meet.
    if (i < points.length - 2) parts.push(circleD(b.x, b.y, w / 2));
  }
  if (parts.length === 0) {
    // Every consecutive pair was coincident (a stationary "drag" with no
    // net movement) — fall back to a single dot rather than drawing nothing.
    return circleD(points[0].x, points[0].y, maxWidth / 2);
  }
  // Cap both ends of the whole stroke with a round joint too, using the
  // width of the segment that touches each end.
  const startTheta = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
  const startW = widthForAngle(startTheta, minWidth, maxWidth);
  const last = points.length - 1;
  const endTheta = Math.atan2(
    points[last].y - points[last - 1].y,
    points[last].x - points[last - 1].x
  );
  const endW = widthForAngle(endTheta, minWidth, maxWidth);
  return [
    circleD(points[0].x, points[0].y, startW / 2),
    ...parts,
    circleD(points[last].x, points[last].y, endW / 2),
  ]
    .filter(Boolean)
    .join(" ");
}
