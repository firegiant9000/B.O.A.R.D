import {
  buildElementIndex,
  entryFromBounds,
  queryBounds,
} from "../spatialIndex";

describe("spatial index", () => {
  const index = buildElementIndex([
    entryFromBounds("a", "path", { minX: 0, minY: 0, maxX: 10, maxY: 10 }),
    entryFromBounds("b", "shape", { minX: 100, minY: 100, maxX: 120, maxY: 120 }),
    entryFromBounds("c", "text", { minX: 5, minY: 5, maxX: 8, maxY: 8 }),
  ]);

  it("returns only entries whose bbox intersects the query box", () => {
    const hits = queryBounds(index, { minX: -1, minY: -1, maxX: 6, maxY: 6 })
      .map((e) => e.id)
      .sort();
    expect(hits).toEqual(["a", "c"]);
  });

  it("preserves id + kind on each hit so it maps back to its collection", () => {
    const hit = queryBounds(index, { minX: 100, minY: 100, maxX: 110, maxY: 110 });
    expect(hit).toHaveLength(1);
    expect(hit[0].id).toBe("b");
    expect(hit[0].kind).toBe("shape");
  });

  it("returns nothing for a box in empty space", () => {
    expect(queryBounds(index, { minX: 50, minY: 50, maxX: 60, maxY: 60 })).toEqual([]);
  });
});
