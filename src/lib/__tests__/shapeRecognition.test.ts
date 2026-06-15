import { recognizeShape } from "../shapeRecognition";
import { Point } from "../viewport";

// --- Fixture builders --------------------------------------------------------

/** Even jitter so a "freehand" fixture isn't a mathematically perfect path. */
function jitter(p: Point, amount: number, seed: number): Point {
  // Deterministic pseudo-noise (no Math.random in tests for reproducibility).
  const n = Math.sin(seed * 12.9898) * 43758.5453;
  const f = (n - Math.floor(n)) * 2 - 1;
  return { x: p.x + f * amount, y: p.y + f * amount };
}

function line(a: Point, b: Point, n = 24, noise = 0): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(jitter({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, noise, i));
  }
  return pts;
}

function rect(x: number, y: number, w: number, h: number, noise = 0): Point[] {
  const c: Point[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x, y },
  ];
  const pts: Point[] = [];
  for (let i = 0; i < c.length - 1; i++) pts.push(...line(c[i], c[i + 1], 10, noise));
  return pts;
}

function ellipse(cx: number, cy: number, rx: number, ry: number, n = 48, noise = 0): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(jitter({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }, noise, i));
  }
  return pts;
}

function triangle(x: number, y: number, w: number, h: number, noise = 0): Point[] {
  const c: Point[] = [
    { x: x + w / 2, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
    { x: x + w / 2, y },
  ];
  const pts: Point[] = [];
  for (let i = 0; i < c.length - 1; i++) pts.push(...line(c[i], c[i + 1], 10, noise));
  return pts;
}

/** A wandering scribble that resembles no primitive. */
function squiggle(): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 6;
    pts.push({ x: 100 + t * 8 + Math.sin(t * 3) * 30, y: 100 + Math.cos(t * 2) * 40 + t * 5 });
  }
  return pts;
}

// --- Positive cases ----------------------------------------------------------

describe("recognizeShape — primitives", () => {
  it("recognizes a horizontal line", () => {
    const r = recognizeShape(line({ x: 50, y: 200 }, { x: 350, y: 205 }, 30, 1.5));
    expect(r?.kind).toBe("line");
    expect(r!.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("recognizes a diagonal line", () => {
    const r = recognizeShape(line({ x: 0, y: 0 }, { x: 300, y: 200 }, 30, 2));
    expect(r?.kind).toBe("line");
    // Line geometry is start + vector (may be negative); here both positive.
    expect(Math.round(r!.width)).toBeGreaterThan(250);
  });

  it("recognizes a rectangle", () => {
    const r = recognizeShape(rect(40, 60, 200, 120, 3));
    expect(r?.kind).toBe("rect");
    expect(r!.width).toBeGreaterThan(150);
    expect(r!.height).toBeGreaterThan(90);
  });

  it("recognizes a square", () => {
    const r = recognizeShape(rect(0, 0, 150, 150, 4));
    expect(r?.kind).toBe("rect");
  });

  it("recognizes an ellipse", () => {
    const r = recognizeShape(ellipse(200, 200, 120, 80, 48, 3));
    expect(r?.kind).toBe("ellipse");
  });

  it("recognizes a circle", () => {
    const r = recognizeShape(ellipse(150, 150, 100, 100, 48, 4));
    expect(r?.kind).toBe("ellipse");
  });

  it("recognizes a triangle", () => {
    const r = recognizeShape(triangle(20, 20, 200, 160, 3));
    expect(r?.kind).toBe("triangle");
  });
});

// --- Negative cases (bias to rejectable false positives) ---------------------

describe("recognizeShape — rejections", () => {
  it("rejects a squiggle", () => {
    expect(recognizeShape(squiggle())).toBeNull();
  });

  it("rejects too few points", () => {
    expect(recognizeShape([{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 2 }])).toBeNull();
  });

  it("rejects a tiny stroke below the size floor", () => {
    expect(recognizeShape(ellipse(10, 10, 3, 3, 20, 0))).toBeNull();
  });

  it("rejects an empty / undefined input", () => {
    expect(recognizeShape([])).toBeNull();
    // @ts-expect-error — guard against a null caller.
    expect(recognizeShape(undefined)).toBeNull();
  });

  it("does not classify an open wavy stroke as a line", () => {
    const wavy: Point[] = [];
    for (let i = 0; i <= 30; i++) {
      wavy.push({ x: i * 10, y: 100 + Math.sin(i / 2) * 40 });
    }
    expect(recognizeShape(wavy)).toBeNull();
  });
});
