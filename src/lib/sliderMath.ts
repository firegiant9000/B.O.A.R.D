/**
 * Pure position <-> value math for the two hand-rolled sliders Month 5 adds
 * (the alpha slider in `ColorPickerModal`, the continuous width slider in
 * `StrokeWidthModal`) — no slider library is approved for this task, so both
 * are a plain `View` track using RN's bare Responder System props
 * (`onResponderGrant`/`onResponderMove`, not `PanResponder` — see either
 * component's own header comment for why), sharing this one clamp/lerp
 * implementation instead of each re-deriving it slightly differently.
 */

/** Maps a touch's x position (0 at the track's left edge) to a value in
 *  [min, max], clamped to the track's actual width so a drag past either
 *  edge still resolves to a valid in-range value instead of extrapolating.
 *  `trackWidth <= 0` (a layout that hasn't measured yet) returns `min`
 *  rather than dividing by zero. */
export function valueFromPosition(x: number, trackWidth: number, min: number, max: number): number {
  if (!(trackWidth > 0)) return min;
  const clampedX = Math.max(0, Math.min(trackWidth, x));
  const t = clampedX / trackWidth;
  return min + t * (max - min);
}

/** Inverse of `valueFromPosition` — where the thumb should sit (0..trackWidth)
 *  for a given value, so the slider's own render can position it without a
 *  second, hand-written formula that could drift from the drag math above. */
export function positionFromValue(value: number, trackWidth: number, min: number, max: number): number {
  if (!(trackWidth > 0) || max === min) return 0;
  const t = (Math.max(min, Math.min(max, value)) - min) / (max - min);
  return t * trackWidth;
}
