// Month 6 — math elements. Guard-path + memoization + metering tests for the
// `renderMath` callable HANDLER. The renderer and the clock are injected;
// Firestore, board access, the rate limiter and the cache module are mocked so
// every branch is exercised without an emulator (mirrors
// generateFlashcards.test.ts).
//
// As in that file, the cache module is DELIBERATELY backed by a real in-memory
// store rather than a jest.fn() returning a canned value, so the memoization
// test is a genuine two-call behavioural proof and not an assertion about a
// mock's own return value.

jest.mock("firebase-admin/firestore", () => ({ getFirestore: () => ({}) }));
jest.mock("../lib/board");
jest.mock("../ai/rateLimit");
jest.mock("../math/mathCache");

import { type CallableRequest } from "firebase-functions/v2/https";
import {
  handleRenderMath,
  type RenderMathRequest,
  type RenderMathDeps,
} from "../callable/renderMath";
import * as board from "../lib/board";
import * as rateLimit from "../ai/rateLimit";
import * as mathCache from "../math/mathCache";
import { MAX_LATEX_LENGTH, type MathRenderResult } from "../math/mathRender";

const resolveBoardAccess = board.resolveBoardAccess as jest.Mock;
const consumeToken = rateLimit.consumeToken as jest.Mock;
const mathCacheKey = mathCache.mathCacheKey as jest.Mock;
const getCachedMath = mathCache.getCachedMath as jest.Mock;
const putCachedMath = mathCache.putCachedMath as jest.Mock;

const RENDERED: MathRenderResult = { svgPath: "M 0 0 L 10 0 L 10 10 Z", width: 10, height: 10 };

/** A renderer that counts its calls — the only way to prove the cache is
 *  doing anything at all. Echoes the latex into the path so two different
 *  expressions are distinguishable in the output. */
function makeRenderer(result: MathRenderResult = RENDERED) {
  return jest.fn(async (latex: string) => ({ ...result, svgPath: `${result.svgPath} ${latex}` }));
}

function deps(render: RenderMathDeps["render"]): RenderMathDeps {
  return { render };
}

const data: RenderMathRequest = { boardId: "board-1", latex: "x^2" };

function req(over: Partial<CallableRequest<RenderMathRequest>> = {}) {
  return { auth: { uid: "u1" }, data, ...over } as CallableRequest<RenderMathRequest>;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: true, isAdmin: false });
  consumeToken.mockResolvedValue(true);
  getCachedMath.mockResolvedValue(null);
  putCachedMath.mockResolvedValue(undefined);
  mathCacheKey.mockImplementation(
    (latex: string, display: boolean) => `${display ? "d" : "i"}:${latex}`
  );
});

describe("renderMath callable — guards (Month 6)", () => {
  it("rejects an unauthenticated caller", async () => {
    const render = makeRenderer();
    await expect(handleRenderMath(req({ auth: undefined }), deps(render), 0)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects a missing boardId", async () => {
    await expect(
      handleRenderMath(
        req({ data: { boardId: "", latex: "x" } }),
        deps(makeRenderer()),
        0
      )
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("denies a non-member of the board", async () => {
    resolveBoardAccess.mockResolvedValue({ workspaceId: "wsA", isMember: false, isAdmin: false });
    const render = makeRenderer();
    await expect(handleRenderMath(req(), deps(render), 0)).rejects.toMatchObject({
      code: "permission-denied",
    });
    // The membership check must precede any work — a non-member must not be
    // able to spend the board's rate bucket or read its cache.
    expect(consumeToken).not.toHaveBeenCalled();
    expect(getCachedMath).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("surfaces a missing board as not-found", async () => {
    resolveBoardAccess.mockResolvedValue(null);
    await expect(handleRenderMath(req(), deps(makeRenderer()), 0)).rejects.toMatchObject({
      code: "not-found",
    });
  });
});

describe("renderMath callable — a bad expression is data, not an exception (Month 6)", () => {
  it("returns the renderer's structured error as a 200 rather than throwing", async () => {
    const render = jest.fn(async () => ({
      svgPath: "",
      width: 0,
      height: 0,
      error: "Missing close brace",
    }));
    const res = await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "\\frac{" } }),
      deps(render),
      0
    );
    expect(res).toEqual({
      svgPath: "",
      width: 0,
      height: 0,
      cached: false,
      error: "Missing close brace",
    });
  });

  it("does not cache a refusal", async () => {
    const render = jest.fn(async () => ({ svgPath: "", width: 0, height: 0, error: "nope" }));
    await handleRenderMath(req(), deps(render), 0);
    expect(putCachedMath).not.toHaveBeenCalled();
  });

  it("returns an error (not a throw, not a render) for an empty expression", async () => {
    const render = makeRenderer();
    const res = await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "   " } }),
      deps(render),
      0
    );
    expect(res.error).toBe("Enter an equation.");
    expect(render).not.toHaveBeenCalled();
    // Refused at the trust boundary, before the board read.
    expect(resolveBoardAccess).not.toHaveBeenCalled();
  });

  it("refuses over-length latex at the boundary, before the board read or the renderer", async () => {
    const render = makeRenderer();
    const res = await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "x".repeat(MAX_LATEX_LENGTH + 1) } }),
      deps(render),
      0
    );
    expect(res.error).toContain("too long");
    expect(resolveBoardAccess).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});

describe("renderMath callable — metering (Month 6)", () => {
  it("uses its OWN bucket key and its OWN, looser config — not the shared AI bucket", async () => {
    await handleRenderMath(req(), deps(makeRenderer()), 1234);
    expect(consumeToken).toHaveBeenCalledWith(
      expect.anything(),
      "math-wsA",
      1234,
      expect.objectContaining({ capacity: 60, refillPerSec: 1 })
    );
    // The key must not be the bare workspace id: sharing the default bucket
    // would let three equations in a row deny the next AI call.
    expect(consumeToken).not.toHaveBeenCalledWith(expect.anything(), "wsA", expect.anything(), expect.anything());
  });

  it("buckets a legacy no-workspace board per user so a missing workspaceId cannot sidestep the limiter", async () => {
    resolveBoardAccess.mockResolvedValue({ workspaceId: "", isMember: true, isAdmin: false });
    await handleRenderMath(req(), deps(makeRenderer()), 0);
    expect(consumeToken).toHaveBeenCalledWith(
      expect.anything(),
      "math-solo-u1",
      0,
      expect.anything()
    );
  });

  it("throws resource-exhausted with details.reason when the bucket denies", async () => {
    consumeToken.mockResolvedValue(false);
    const render = makeRenderer();
    await expect(handleRenderMath(req(), deps(render), 0)).rejects.toMatchObject({
      code: "resource-exhausted",
      details: { reason: "rate-limit" },
    });
    expect(render).not.toHaveBeenCalled();
  });

  it("meters a CACHE HIT too — unlike the AI callables, whose buckets guard provider spend", async () => {
    // A hit still costs a Firestore read and an invocation, so a loop of
    // identical requests must not slip past the limiter. This is the single
    // assertion that pins the deliberate ordering difference.
    getCachedMath.mockResolvedValue({
      svgPath: "M 0 0",
      width: 4,
      height: 4,
      createdAt: 0,
    });
    const res = await handleRenderMath(req(), deps(makeRenderer()), 0);
    expect(res.cached).toBe(true);
    expect(consumeToken).toHaveBeenCalledTimes(1);
  });

  it("is denied before the cache is even read when the bucket is empty", async () => {
    consumeToken.mockResolvedValue(false);
    await expect(handleRenderMath(req(), deps(makeRenderer()), 0)).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    expect(getCachedMath).not.toHaveBeenCalled();
  });
});

describe("renderMath callable — memoization (Month 6)", () => {
  /** Back the mocked cache module with a real store, so get/put actually
   *  round-trip and the two-call test exercises the real code path. */
  function useRealStore() {
    const store = new Map<string, unknown>();
    getCachedMath.mockImplementation(async (_db: unknown, _boardId: string, key: string) =>
      (store.get(key) as never) ?? null
    );
    putCachedMath.mockImplementation(
      async (_db: unknown, _boardId: string, key: string, value: unknown) => {
        store.set(key, value);
      }
    );
    return store;
  }

  // The brief's second test: "does not call the renderer twice for a cached
  // expression" — one call.
  it("does not call the renderer twice for a cached expression", async () => {
    useRealStore();
    const render = makeRenderer();

    const first = await handleRenderMath(req(), deps(render), 0);
    const second = await handleRenderMath(req(), deps(render), 1000);

    expect(render).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.svgPath).toBe(first.svgPath);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it("a DIFFERENT expression is not memoized against the first — the renderer runs again", async () => {
    // The falsifier: without this, a handler that returned the first result
    // for every input would pass the test above.
    useRealStore();
    const render = makeRenderer();

    const first = await handleRenderMath(req(), deps(render), 0);
    const second = await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "y^3" } }),
      deps(render),
      1000
    );

    expect(render).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
    expect(second.svgPath).not.toBe(first.svgPath);
  });

  it("keys display and inline mode apart, so one does not serve the other", async () => {
    useRealStore();
    const render = makeRenderer();

    await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "\\sum_i i", displayMode: true } }),
      deps(render),
      0
    );
    await handleRenderMath(
      req({ data: { boardId: "board-1", latex: "\\sum_i i", displayMode: false } }),
      deps(render),
      1
    );

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenNthCalledWith(1, "\\sum_i i", true);
    expect(render).toHaveBeenNthCalledWith(2, "\\sum_i i", false);
  });

  it("defaults to display mode when the request omits it", async () => {
    const render = makeRenderer();
    await handleRenderMath(req(), deps(render), 0);
    expect(render).toHaveBeenCalledWith("x^2", true);
  });

  it("still returns the rendering when the cache write fails", async () => {
    putCachedMath.mockRejectedValue(new Error("firestore down"));
    const res = await handleRenderMath(req(), deps(makeRenderer()), 0);
    expect(res.error).toBeUndefined();
    expect(res.svgPath).toContain("M 0 0");
    expect(res.cached).toBe(false);
  });

  it("serves a hit without calling the renderer at all", async () => {
    getCachedMath.mockResolvedValue({
      svgPath: "M 1 1 L 2 2",
      width: 7,
      height: 8,
      createdAt: 0,
    });
    const render = makeRenderer();
    const res = await handleRenderMath(req(), deps(render), 0);
    expect(res).toEqual({ svgPath: "M 1 1 L 2 2", width: 7, height: 8, cached: true });
    expect(render).not.toHaveBeenCalled();
    expect(putCachedMath).not.toHaveBeenCalled();
  });
});
