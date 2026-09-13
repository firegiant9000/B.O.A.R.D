jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
const mockCallable = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: () => mockCallable,
}));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as mathService from "../mathService";

const addDoc = fs.addDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;
const collection = fs.collection as jest.Mock;
const doc = fs.doc as jest.Mock;

// Month 6 — math elements. The client half: reading a (possibly corrupt)
// document, routing the render callable's two very different failure shapes,
// and the render-before-write ordering that stops a malformed expression
// leaving an invisible row behind.

const RENDERED = { svgPath: "M 0 0 L 10 0 L 10 8 Z", width: 30, height: 12, cached: false };

function goodDoc(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "math",
    boardId: "b1",
    userId: "u1",
    latex: "x^2",
    svgPath: "M 0 0 L 1 1",
    x: 10,
    y: 20,
    width: 30,
    height: 12,
    scale: 1,
    createdAt: ts(new Date("2026-01-01T00:00:00Z")),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallable.mockResolvedValue({ data: RENDERED });
  addDoc.mockResolvedValue({ id: "m-new" });
});

describe("mapMathDoc — tolerant, but fails a corrupt number closed (Month 6)", () => {
  it("maps a well-formed document", () => {
    const el = mathService.mapMathDoc("m1", goodDoc());
    expect(el).toMatchObject({
      id: "m1",
      schemaVersion: 1,
      type: "math",
      latex: "x^2",
      svgPath: "M 0 0 L 1 1",
      x: 10,
      y: 20,
      width: 30,
      height: 12,
      scale: 1,
    });
    expect(el!.bbox).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 32 });
  });

  it.each([
    ["no data at all", null],
    ["no latex", { ...goodDoc(), latex: undefined }],
    ["an empty latex", { ...goodDoc(), latex: "" }],
    ["no svgPath", { ...goodDoc(), svgPath: undefined }],
    ["an empty svgPath", { ...goodDoc(), svgPath: "" }],
    ["a non-string svgPath", { ...goodDoc(), svgPath: 12 }],
  ])("drops a document with %s — there is nothing to draw or edit", (_label, data) => {
    expect(mathService.mapMathDoc("m1", data)).toBeNull();
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "10"],
    ["null", null],
    ["undefined", undefined],
  ])("falls x/y back to 0 for %s rather than propagating it into geometry", (_label, value) => {
    // `typeof NaN === "number"`. A NaN x would poison every bounds union,
    // culling test and hit-test the element reaches.
    const el = mathService.mapMathDoc("m1", goodDoc({ x: value, y: value }));
    expect(el!.x).toBe(0);
    expect(el!.y).toBe(0);
    expect(Number.isFinite(el!.bbox!.minX)).toBe(true);
  });

  it.each([
    ["NaN", NaN],
    ["zero", 0],
    ["negative", -4],
    ["Infinity", Infinity],
  ])("falls width/height/scale back to a usable value for %s", (_label, value) => {
    // A zero-area element is invisible AND untappable, so it could never be
    // selected to delete; a negative scale mirrors the equation.
    const el = mathService.mapMathDoc("m1", goodDoc({ width: value, height: value, scale: value }));
    expect(el!.width).toBeGreaterThan(0);
    expect(el!.height).toBeGreaterThan(0);
    expect(el!.scale).toBe(1);
  });

  it("recomputes bbox from the validated geometry rather than trusting a stored one", () => {
    const el = mathService.mapMathDoc(
      "m1",
      goodDoc({ bbox: { minX: -999, minY: -999, maxX: -998, maxY: -998 } })
    );
    expect(el!.bbox).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 32 });
  });
});

describe("renderMath — two failure shapes, routed apart (Month 6)", () => {
  it("returns the callable's path data on the happy path", async () => {
    await expect(mathService.renderMath("b1", "x^2")).resolves.toEqual({
      svgPath: RENDERED.svgPath,
      width: 30,
      height: 12,
      cached: false,
    });
    expect(mockCallable).toHaveBeenCalledWith({ boardId: "b1", latex: "x^2", displayMode: true });
  });

  it("rethrows a malformed-LaTeX response as TeX's own message, with NO code", async () => {
    // The 200-with-`error` shape. It must NOT look like a service failure:
    // the composer shows this inline and keeps what the user typed.
    mockCallable.mockResolvedValueOnce({
      data: { svgPath: "", width: 0, height: 0, cached: false, error: "Missing close brace" },
    });
    const err = await mathService.renderMath("b1", "\\frac{").catch((e) => e);
    expect(err.message).toBe("Missing close brace");
    expect(err.code).toBeUndefined();
  });

  it("preserves .code AND .details from a real callable rejection", async () => {
    // `details.reason` is how a caller tells "retry in a moment" from
    // "upgrade" — this callable only ever means the former, and says so.
    mockCallable.mockRejectedValueOnce(
      Object.assign(new Error("Too many equations at once."), {
        code: "functions/resource-exhausted",
        details: { reason: "rate-limit" },
      })
    );
    const err = await mathService.renderMath("b1", "x^2").catch((e) => e);
    expect(err.code).toBe("functions/resource-exhausted");
    expect(err.details).toEqual({ reason: "rate-limit" });
  });

  it("rejects a response whose geometry is unusable rather than returning it", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { svgPath: "M 0 0", width: NaN, height: 12, cached: false },
    });
    await expect(mathService.renderMath("b1", "x^2")).rejects.toThrow(/render/i);
  });

  it("passes displayMode through", async () => {
    await mathService.renderMath("b1", "\\sum_i i", false);
    expect(mockCallable).toHaveBeenCalledWith({
      boardId: "b1",
      latex: "\\sum_i i",
      displayMode: false,
    });
  });
});

describe("createMathElement — render first, write second (Month 6)", () => {
  it("writes the rendered path data, the scaled box and a bbox", async () => {
    const id = await mathService.createMathElement({
      boardId: "b1",
      latex: "x^2",
      x: 100,
      y: 200,
      userId: "u1",
      scale: 2,
    });
    expect(id).toBe("m-new");
    expect(collection).toHaveBeenCalledWith({}, "boards", "b1", "mathElements");
    const written = addDoc.mock.calls[0][1];
    expect(written).toMatchObject({
      schemaVersion: 1,
      type: "math",
      latex: "x^2",
      svgPath: RENDERED.svgPath,
      x: 100,
      y: 200,
      // Natural size times scale — the box a selection/hit-test uses directly.
      width: 60,
      height: 24,
      scale: 2,
      bbox: { minX: 100, minY: 200, maxX: 160, maxY: 224 },
    });
  });

  it("writes NOTHING when the render fails", async () => {
    // A document with no svgPath is dropped by mapMathDoc, so writing first
    // would leave an invisible, unselectable row behind on every typo.
    mockCallable.mockResolvedValueOnce({
      data: { svgPath: "", width: 0, height: 0, cached: false, error: "Missing close brace" },
    });
    await expect(
      mathService.createMathElement({ boardId: "b1", latex: "\\frac{", x: 0, y: 0 })
    ).rejects.toThrow("Missing close brace");
    expect(addDoc).not.toHaveBeenCalled();
  });

  it("defaults a missing or unusable scale to 1", async () => {
    await mathService.createMathElement({
      boardId: "b1",
      latex: "x",
      x: 0,
      y: 0,
      scale: NaN,
    });
    expect(addDoc.mock.calls[0][1]).toMatchObject({ scale: 1, width: 30, height: 12 });
  });
});

describe("updateMathLatex — the only other write that renders (Month 6)", () => {
  it("re-typesets, keeps position and scale, and re-derives the box", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { svgPath: "M 9 9", width: 50, height: 20, cached: false },
    });
    await mathService.updateMathLatex("b1", "m1", "y^3", { x: 7, y: 8, scale: 2 });
    expect(doc).toHaveBeenCalledWith({}, "boards", "b1", "mathElements", "m1");
    expect(updateDoc.mock.calls[0][1]).toEqual({
      latex: "y^3",
      svgPath: "M 9 9",
      width: 100,
      height: 40,
      scale: 2,
      bbox: { minX: 7, minY: 8, maxX: 107, maxY: 48 },
    });
  });

  it("writes nothing when the re-render fails", async () => {
    mockCallable.mockResolvedValueOnce({
      data: { svgPath: "", width: 0, height: 0, cached: false, error: "Missing close brace" },
    });
    await expect(
      mathService.updateMathLatex("b1", "m1", "\\frac{", { x: 0, y: 0, scale: 1 })
    ).rejects.toThrow("Missing close brace");
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe("geometry-only writes never call the renderer (Month 6)", () => {
  it("saveMathElement persists already-typeset path data with no render call", async () => {
    // The duplicate/paste path. The whole point of caching `svgPath` on the
    // document is that copying an equation costs one Firestore write.
    await mathService.saveMathElement("b1", {
      schemaVersion: 1,
      type: "math",
      boardId: "b1",
      userId: "u1",
      latex: "x^2",
      svgPath: "M 0 0",
      x: 5,
      y: 6,
      width: 10,
      height: 4,
      scale: 1,
    });
    expect(mockCallable).not.toHaveBeenCalled();
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      bbox: { minX: 5, minY: 6, maxX: 15, maxY: 10 },
    });
  });

  it("updateMathElement / deleteMathElement never render", async () => {
    await mathService.updateMathElement("b1", "m1", { x: 1, y: 2 });
    await mathService.deleteMathElement("b1", "m1");
    expect(mockCallable).not.toHaveBeenCalled();
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
  });
});

describe("batched geometry writes (Month 6)", () => {
  const writeBatch = fs.writeBatch as jest.Mock;
  const getDocs = fs.getDocs as jest.Mock;

  /** The mock's batch object for the Nth writeBatch() call. */
  const batchAt = (n: number) => writeBatch.mock.results[n].value;

  it("batchUpdateMathElements writes one update per element and commits", async () => {
    // The move/resize/rotate path in useBoardElements. Never renders.
    await mathService.batchUpdateMathElements("b1", [
      { id: "m1", data: { x: 1, y: 2 } },
      { id: "m2", data: { x: 3, y: 4 } },
    ]);
    expect(batchAt(0).update).toHaveBeenCalledTimes(2);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
    expect(mockCallable).not.toHaveBeenCalled();
  });

  it("chunks past Firestore's 500-write batch limit rather than committing one oversized batch", async () => {
    const updates = Array.from({ length: 501 }, (_, i) => ({ id: `m${i}`, data: { x: i } }));
    await mathService.batchUpdateMathElements("b1", updates);
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchAt(0).update).toHaveBeenCalledTimes(500);
    expect(batchAt(1).update).toHaveBeenCalledTimes(1);
  });

  it("commits nothing at all for an empty update list", async () => {
    await mathService.batchUpdateMathElements("b1", []);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("batchDeleteMathElements deletes each id", async () => {
    await mathService.batchDeleteMathElements("b1", ["m1", "m2", "m3"]);
    expect(batchAt(0).delete).toHaveBeenCalledTimes(3);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
  });

  it("clearBoardMathElements deletes every document the collection holds", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["m1", goodDoc()],
        ["m2", goodDoc()],
      ])
    );
    await mathService.clearBoardMathElements("b1");
    expect(collection).toHaveBeenCalledWith({}, "boards", "b1", "mathElements");
    expect(batchAt(0).delete).toHaveBeenCalledTimes(2);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
  });
});

describe("isMathConfigured (Month 6)", () => {
  it("reports the build-time flag — an affordance gate, never a security one", () => {
    // MATH_ENABLED is inlined into the client bundle and therefore public and
    // patchable; what actually stops a write is firestore.rules plus the
    // callable's own membership check.
    expect(typeof mathService.isMathConfigured()).toBe("boolean");
  });
});

describe("subscribeToBoardMathElements (Month 6)", () => {
  it("maps and filters the snapshot, dropping undrawable documents", () => {
    const onChange = jest.fn();
    mathService.subscribeToBoardMathElements("b1", onChange);
    const handler = onSnapshot.mock.calls[0][1];
    handler(
      makeQuerySnap([
        ["m1", goodDoc()],
        ["m2", goodDoc({ svgPath: "" })], // nothing to draw — dropped
        ["m3", goodDoc({ latex: "y", svgPath: "M 1 1" })],
      ])
    );
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.map((e: { id: string }) => e.id)).toEqual(["m1", "m3"]);
  });
});

describe("mathBoxOf vs mathElementBbox (Month 6)", () => {
  it("mathBoxOf always computes; mathElementBbox prefers a stored box", () => {
    // Getting this backwards in a write path hands back the PRE-change box —
    // the selection outline and the drawn glyphs then disagree.
    const stored = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const el = { ...mathService.mapMathDoc("m1", goodDoc())!, bbox: stored };
    expect(mathService.mathElementBbox(el)).toBe(stored);
    expect(mathService.mathBoxOf(el)).toEqual({ minX: 10, minY: 20, maxX: 40, maxY: 32 });
  });
});

describe("MAX_LATEX_LENGTH is advisory here (Month 6)", () => {
  it("is a number the composer can use as a field cap", () => {
    // Deliberately NOT enforced in this module: the real limit lives inside
    // the callable, which is the trust boundary. A client-side cap is an
    // affordance — see the constant's own comment.
    expect(typeof mathService.MAX_LATEX_LENGTH).toBe("number");
    expect(mathService.MAX_LATEX_LENGTH).toBeGreaterThan(0);
  });
});
