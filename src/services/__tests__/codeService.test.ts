jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));

import * as fs from "firebase/firestore";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as codeService from "../codeService";
import { CODE_DEFAULT_FONT_SIZE, CODE_DEFAULT_LANGUAGE, layoutCodeBox } from "../../lib/codeRender";

const addDoc = fs.addDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const onSnapshot = fs.onSnapshot as jest.Mock;
const collection = fs.collection as jest.Mock;
const doc = fs.doc as jest.Mock;

// Month 6 — code elements. UNLIKE mathService, there is no callable and
// nothing to await before the write: `code`/`language` ARE the element (see
// CodeElement's type comment), so these tests exercise the tolerant reader,
// the pure-layout-derived geometry on write, and the "no render call, ever"
// property that falls directly out of tokenizing being synchronous.

function goodDoc(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "code",
    boardId: "b1",
    userId: "u1",
    code: "const x = 1;",
    language: "ts",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    fontSize: 14,
    rotation: 0,
    createdAt: ts(new Date("2026-01-01T00:00:00Z")),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  addDoc.mockResolvedValue({ id: "c-new" });
});

describe("mapCodeDoc — tolerant, but fails a corrupt value closed (Month 6)", () => {
  it("maps a well-formed document", () => {
    const el = codeService.mapCodeDoc("c1", goodDoc());
    expect(el).toMatchObject({
      id: "c1",
      schemaVersion: 1,
      type: "code",
      code: "const x = 1;",
      language: "ts",
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      fontSize: 14,
    });
    expect(el!.bbox).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });

  it("drops a document with no `code` string at all", () => {
    expect(codeService.mapCodeDoc("c1", null)).toBeNull();
    expect(codeService.mapCodeDoc("c1", { ...goodDoc(), code: undefined })).toBeNull();
    expect(codeService.mapCodeDoc("c1", { ...goodDoc(), code: 12 })).toBeNull();
  });

  it("keeps a document with EMPTY code — unlike math, there is still a box to select/retype into", () => {
    const el = codeService.mapCodeDoc("c1", goodDoc({ code: "" }));
    expect(el).not.toBeNull();
    expect(el!.code).toBe("");
  });

  it("falls an unrecognized language back to the default rather than an id the highlighter never loaded", () => {
    const el = codeService.mapCodeDoc("c1", goodDoc({ language: "cobol" }));
    expect(el!.language).toBe(CODE_DEFAULT_LANGUAGE);
  });

  it.each([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a string", "10"],
    ["null", null],
    ["undefined", undefined],
  ])("falls x/y back to 0 for %s rather than propagating it into geometry", (_label, value) => {
    const el = codeService.mapCodeDoc("c1", goodDoc({ x: value, y: value }));
    expect(el!.x).toBe(0);
    expect(el!.y).toBe(0);
    expect(Number.isFinite(el!.bbox!.minX)).toBe(true);
  });

  it.each([
    ["NaN", NaN],
    ["zero", 0],
    ["negative", -4],
    ["Infinity", Infinity],
  ])("falls width/height/fontSize back to a usable value for %s", (_label, value) => {
    const el = codeService.mapCodeDoc(
      "c1",
      goodDoc({ width: value, height: value, fontSize: value })
    );
    expect(el!.width).toBeGreaterThan(0);
    expect(el!.height).toBeGreaterThan(0);
    expect(el!.fontSize).toBe(CODE_DEFAULT_FONT_SIZE);
  });

  it("recomputes bbox from the validated geometry rather than trusting a stored one", () => {
    const el = codeService.mapCodeDoc(
      "c1",
      goodDoc({ bbox: { minX: -999, minY: -999, maxX: -998, maxY: -998 } })
    );
    expect(el!.bbox).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });
});

describe("createCodeElement — pure layout, no render call (Month 6)", () => {
  it("writes the laid-out box for the given code/fontSize", async () => {
    const layout = layoutCodeBox("const x = 1;", 14);
    const id = await codeService.createCodeElement({
      boardId: "b1",
      code: "const x = 1;",
      language: "ts",
      x: 100,
      y: 200,
      userId: "u1",
      fontSize: 14,
    });
    expect(id).toBe("c-new");
    expect(collection).toHaveBeenCalledWith({}, "boards", "b1", "codeElements");
    const written = addDoc.mock.calls[0][1];
    expect(written).toMatchObject({
      schemaVersion: 1,
      type: "code",
      code: "const x = 1;",
      language: "ts",
      x: 100,
      y: 200,
      width: layout.width,
      height: layout.height,
      fontSize: 14,
      rotation: 0,
      bbox: { minX: 100, minY: 200, maxX: 100 + layout.width, maxY: 200 + layout.height },
    });
  });

  it("defaults a missing or unusable fontSize", async () => {
    await codeService.createCodeElement({
      boardId: "b1",
      code: "x",
      language: "ts",
      x: 0,
      y: 0,
      fontSize: NaN,
    });
    expect(addDoc.mock.calls[0][1]).toMatchObject({ fontSize: CODE_DEFAULT_FONT_SIZE });
  });

  it("falls an unrecognized language back to the default on write, same as on read", async () => {
    await codeService.createCodeElement({
      boardId: "b1",
      code: "x",
      // @ts-expect-error — deliberately an id the highlighter never loaded
      language: "cobol",
      x: 0,
      y: 0,
    });
    expect(addDoc.mock.calls[0][1]).toMatchObject({ language: CODE_DEFAULT_LANGUAGE });
  });
});

describe("updateCodeSource — re-lays-out, keeps position/fontSize (Month 6)", () => {
  it("re-derives width/height from the new source at the current fontSize", async () => {
    const newLayout = layoutCodeBox("a much longer line of code here", 14);
    await codeService.updateCodeSource("b1", "c1", "a much longer line of code here", "ts", {
      x: 7,
      y: 8,
      fontSize: 14,
    });
    expect(doc).toHaveBeenCalledWith({}, "boards", "b1", "codeElements", "c1");
    expect(updateDoc.mock.calls[0][1]).toEqual({
      code: "a much longer line of code here",
      language: "ts",
      width: newLayout.width,
      height: newLayout.height,
      bbox: {
        minX: 7,
        minY: 8,
        maxX: 7 + newLayout.width,
        maxY: 8 + newLayout.height,
      },
    });
  });
});

describe("saveCodeElement — no layout call, one write (Month 6)", () => {
  it("persists already-known geometry as-is — the duplicate/paste path", async () => {
    await codeService.saveCodeElement("b1", {
      schemaVersion: 1,
      type: "code",
      boardId: "b1",
      userId: "u1",
      code: "x",
      language: "ts",
      x: 5,
      y: 6,
      width: 40,
      height: 20,
      fontSize: 14,
      rotation: 0,
    });
    expect(addDoc.mock.calls[0][1]).toMatchObject({
      x: 5,
      y: 6,
      width: 40,
      height: 20,
      bbox: { minX: 5, minY: 6, maxX: 45, maxY: 26 },
    });
  });
});

describe("delete (Month 6)", () => {
  it("deletes by board + element id", async () => {
    await codeService.deleteCodeElement("b1", "c1");
    expect(doc).toHaveBeenCalledWith({}, "boards", "b1", "codeElements", "c1");
    expect(deleteDoc).toHaveBeenCalled();
  });
});

describe("updateCodeElement — generic geometry update, no layout call (Month 6)", () => {
  it("writes exactly the given fields, unlike updateCodeSource which re-lays-out", async () => {
    await codeService.updateCodeElement("b1", "c1", { x: 1, y: 2, rotation: 90 });
    expect(doc).toHaveBeenCalledWith({}, "boards", "b1", "codeElements", "c1");
    expect(updateDoc.mock.calls[0][1]).toEqual({ x: 1, y: 2, rotation: 90 });
  });
});

describe("batched geometry writes (Month 6)", () => {
  const writeBatch = fs.writeBatch as jest.Mock;
  const getDocs = fs.getDocs as jest.Mock;

  /** The mock's batch object for the Nth writeBatch() call. */
  const batchAt = (n: number) => writeBatch.mock.results[n].value;

  it("batchUpdateCodeElements writes one update per element and commits", async () => {
    // The move/resize/rotate/z-order path in useBoardElements.
    await codeService.batchUpdateCodeElements("b1", [
      { id: "c1", data: { x: 1, y: 2 } },
      { id: "c2", data: { x: 3, y: 4 } },
    ]);
    expect(batchAt(0).update).toHaveBeenCalledTimes(2);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
  });

  it("chunks past Firestore's 500-write batch limit rather than committing one oversized batch", async () => {
    const updates = Array.from({ length: 501 }, (_, i) => ({ id: `c${i}`, data: { x: i } }));
    await codeService.batchUpdateCodeElements("b1", updates);
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchAt(0).update).toHaveBeenCalledTimes(500);
    expect(batchAt(1).update).toHaveBeenCalledTimes(1);
  });

  it("commits nothing at all for an empty update list", async () => {
    await codeService.batchUpdateCodeElements("b1", []);
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it("batchDeleteCodeElements deletes each id", async () => {
    await codeService.batchDeleteCodeElements("b1", ["c1", "c2", "c3"]);
    expect(batchAt(0).delete).toHaveBeenCalledTimes(3);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
  });

  it("clearBoardCodeElements deletes every document the collection holds", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["c1", goodDoc()],
        ["c2", goodDoc()],
      ])
    );
    await codeService.clearBoardCodeElements("b1");
    expect(collection).toHaveBeenCalledWith({}, "boards", "b1", "codeElements");
    expect(batchAt(0).delete).toHaveBeenCalledTimes(2);
    expect(batchAt(0).commit).toHaveBeenCalledTimes(1);
  });
});

describe("isCodeConfigured (Month 6)", () => {
  it("reports the build-time flag — an affordance gate, never a security one", () => {
    // CODE_ENABLED is inlined into the client bundle and therefore public and
    // patchable; what actually stops a write is firestore.rules alone (there
    // is no callable in this feature's path at all — see this module's
    // header).
    expect(typeof codeService.isCodeConfigured()).toBe("boolean");
  });
});

describe("subscribeToBoardCodeElements (Month 6)", () => {
  it("maps and filters the snapshot, dropping documents with no `code` string", () => {
    const onChange = jest.fn();
    codeService.subscribeToBoardCodeElements("b1", onChange);
    expect(collection).toHaveBeenCalledWith({}, "boards", "b1", "codeElements");
    const handler = onSnapshot.mock.calls[0][1];
    handler(
      makeQuerySnap([
        ["c1", goodDoc()],
        ["c2", { ...goodDoc(), code: undefined }], // not a code element — dropped
        ["c3", goodDoc({ code: "", language: "py" })], // empty code IS valid, unlike math
      ])
    );
    const emitted = onChange.mock.calls[0][0];
    expect(emitted.map((e: { id: string }) => e.id)).toEqual(["c1", "c3"]);
  });
});

describe("codeBoxOf vs codeElementBbox (Month 6)", () => {
  it("codeBoxOf always computes; codeElementBbox prefers a stored box", () => {
    // Getting this backwards in a write path hands back the PRE-change box —
    // the selection outline and the drawn text then disagree.
    const stored = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const el = { ...codeService.mapCodeDoc("c1", goodDoc())!, bbox: stored };
    expect(codeService.codeElementBbox(el)).toBe(stored);
    expect(codeService.codeBoxOf(el)).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
  });
});
