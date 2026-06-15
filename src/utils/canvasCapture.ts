import { Platform } from "react-native";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

const MAX_EDGE = 1024;
const MAX_DATA_URL_BYTES = 900_000;

/** A screen-space rectangle (canvas pixels), as produced by mapping a selection's
 *  board-space bounds through the viewport. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Captures just the selected region of the board as a PNG data URL (Phase 10 OCR).
 * Captures the whole board, then crops to `rect` (clamped to the canvas). The crop
 * is computed in normalized fractions of the canvas so it is independent of the
 * captured image's pixel size — web downscales to `maxEdge`, native may capture
 * square — keeping both platforms correct without threading the capture scale out.
 * Returns null when capture is unavailable; returns the full image when the rect
 * is degenerate.
 */
export async function captureSelectionImage(
  canvasRef: any,
  rect: ScreenRect,
  canvasSize: { width: number; height: number },
  maxEdge: number = MAX_EDGE
): Promise<string | null> {
  if (!canvasSize.width || !canvasSize.height) return null;
  // Capture large enough that the cropped region keeps OCR-legible detail.
  const captureEdge = Math.max(maxEdge, canvasSize.width, canvasSize.height);
  const full = await captureBoardImage(canvasRef, captureEdge);
  if (!full) return null;

  const nx = clamp01(rect.x / canvasSize.width);
  const ny = clamp01(rect.y / canvasSize.height);
  const nw = clamp01(rect.width / canvasSize.width);
  const nh = clamp01(rect.height / canvasSize.height);
  if (nw <= 0 || nh <= 0) return full;

  try {
    return Platform.OS === "web"
      ? await cropWeb(full, nx, ny, nw, nh)
      : await cropNative(full, nx, ny, nw, nh);
  } catch (err) {
    console.warn("[canvasCapture] selection crop failed:", err);
    // Fall back to the whole board so OCR can still run (just less precisely).
    return full;
  }
}

/** Web crop via an offscreen canvas (mirrors captureSvgAsPng's canvas usage). */
async function cropWeb(
  dataUrl: string,
  nx: number,
  ny: number,
  nw: number,
  nh: number
): Promise<string | null> {
  if (typeof document === "undefined") return dataUrl;
  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("crop image load failed"));
    i.src = dataUrl;
  });
  const sx = Math.round(nx * img.width);
  const sy = Math.round(ny * img.height);
  const sw = Math.max(1, Math.round(nw * img.width));
  const sh = Math.max(1, Math.round(nh * img.height));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL("image/png");
}

/** Native crop via expo-image-manipulator (already a dependency, see imagePicker). */
async function cropNative(
  dataUrl: string,
  nx: number,
  ny: number,
  nw: number,
  nh: number
): Promise<string | null> {
  // A no-op render exposes the captured image's pixel dimensions, so the
  // normalized rect can be turned into a pixel crop.
  const rendered = await ImageManipulator.manipulate(dataUrl).renderAsync();
  const W = rendered.width;
  const H = rendered.height;
  if (!W || !H) return dataUrl;
  const cropped = await ImageManipulator.manipulate(dataUrl)
    .crop({
      originX: Math.round(nx * W),
      originY: Math.round(ny * H),
      width: Math.max(1, Math.round(nw * W)),
      height: Math.max(1, Math.round(nh * H)),
    })
    .renderAsync();
  const out = await cropped.saveAsync({ format: SaveFormat.PNG, base64: true });
  return out.base64 ? `data:image/png;base64,${out.base64}` : dataUrl;
}

/**
 * Unified board snapshot capture (Phase 3). Returns a PNG data URL on every
 * platform, or null when capture is unavailable.
 *
 * - Web: resolves the underlying DOM <svg> from the canvas ref and rasterizes it
 *   via `captureSvgAsPng` (unchanged behavior).
 * - Native: uses react-native-svg's built-in `toDataURL` on the <Svg> ref — no
 *   extra dependency. The board's `canvasSvgRef` already forwards to that <Svg>.
 *
 * Pass the raw `canvasSvgRef.current` from the board screen.
 */
export async function captureBoardImage(
  canvasRef: any,
  maxEdge: number = MAX_EDGE
): Promise<string | null> {
  if (Platform.OS === "web") {
    return captureSvgAsPng(resolveWebSvg(canvasRef), maxEdge);
  }
  return captureSvgNative(canvasRef, maxEdge);
}

/** Extracts the DOM <svg> from a react-native-svg-on-web ref, which exposes the
 *  node in different shapes by version. Falls back to a document query. */
function resolveWebSvg(ref: any): SVGSVGElement | null {
  if (typeof document === "undefined") return null;
  let svgEl: SVGSVGElement | null = null;
  if (ref) {
    if (ref.tagName === "svg") svgEl = ref;
    else if (ref.elementRef?.current?.tagName === "svg") svgEl = ref.elementRef.current;
    else if (ref._touchableNode?.tagName === "svg") svgEl = ref._touchableNode;
    else if (typeof ref.querySelector === "function") svgEl = ref.querySelector("svg");
  }
  if (!svgEl) {
    svgEl = document.querySelector(
      ".canvas-container svg, [data-canvas] svg, svg"
    ) as SVGSVGElement | null;
  }
  return svgEl;
}

/** Native capture via react-native-svg's `toDataURL(callback, options)`, which
 *  returns base64 PNG (no `data:` prefix). Matches web's SVG-only capture. */
async function captureSvgNative(
  ref: any,
  maxEdge: number
): Promise<string | null> {
  if (!ref || typeof ref.toDataURL !== "function") return null;
  try {
    const base64: string | null = await new Promise((resolve) => {
      // The options object is honored by newer react-native-svg; older versions
      // ignore it and capture at native size (still bounded by the byte cap).
      ref.toDataURL(
        (data: string) => resolve(data ?? null),
        { width: maxEdge, height: maxEdge }
      );
    });
    if (!base64) return null;
    const dataUrl = base64.startsWith("data:")
      ? base64
      : `data:image/png;base64,${base64}`;
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      console.warn(
        `[canvasCapture] native PNG too large (${dataUrl.length} bytes), skipping snapshot.`
      );
      return null;
    }
    return dataUrl;
  } catch (err) {
    console.warn("[canvasCapture] native capture failed:", err);
    return null;
  }
}

export async function captureSvgAsPng(
  svgEl: SVGSVGElement | null | undefined,
  maxEdge: number = MAX_EDGE
): Promise<string | null> {
  if (Platform.OS !== "web") return null;
  if (!svgEl || typeof window === "undefined") return null;

  try {
    const rect = svgEl.getBoundingClientRect();
    const srcWidth =
      Number(svgEl.getAttribute("width")) || rect.width || 800;
    const srcHeight =
      Number(svgEl.getAttribute("height")) || rect.height || 600;

    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(srcWidth));
    clone.setAttribute("height", String(srcHeight));

    const svgString = new XMLSerializer().serializeToString(clone);
    const xmlHeader = '<?xml version="1.0" encoding="UTF-8"?>';
    const fullSvg = xmlHeader + svgString;
    const encoded = btoa(unescape(encodeURIComponent(fullSvg)));
    const svgDataUrl = `data:image/svg+xml;base64,${encoded}`;

    const img: HTMLImageElement = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("svg image load failed"));
      i.src = svgDataUrl;
    });

    const longest = Math.max(srcWidth, srcHeight);
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const w = Math.max(1, Math.round(srcWidth * scale));
    const h = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const dataUrl = canvas.toDataURL("image/png");
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
      console.warn(
        `[canvasCapture] PNG data URL too large (${dataUrl.length} bytes), skipping snapshot.`
      );
      return null;
    }
    return dataUrl;
  } catch (err) {
    console.warn("[canvasCapture] capture failed:", err);
    return null;
  }
}
