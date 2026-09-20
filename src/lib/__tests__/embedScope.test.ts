import { parseEmbedScope } from "../embedScope";

/**
 * Month 5 — Google Meet add-on shell. `parseEmbedScope` is the one place
 * app/embed/b/[id].tsx decides whether an exchanged embed session renders
 * with editing chrome. It cannot be exercised through the screen itself
 * (expo-router screens aren't render-testable in this app — see the Toolbar/
 * BoardCanvas tests for the same limitation stated elsewhere), so the
 * contract lives here as a small pure function instead.
 */
describe("parseEmbedScope", () => {
  it("resolves the exact literal 'edit' to edit", () => {
    expect(parseEmbedScope("edit")).toBe("edit");
  });

  it("resolves the exact literal 'view' to view", () => {
    expect(parseEmbedScope("view")).toBe("view");
  });

  it("resolves undefined to view (a field the exchange never sent)", () => {
    expect(parseEmbedScope(undefined)).toBe("view");
  });

  it("resolves null to view", () => {
    expect(parseEmbedScope(null)).toBe("view");
  });

  it("resolves an empty string to view", () => {
    expect(parseEmbedScope("")).toBe("view");
  });

  it("rejects an unknown scope string rather than defaulting it to edit", () => {
    // If this ever regressed to something like `rawScope !== "view"`, this is
    // the case that would silently start returning "edit".
    expect(parseEmbedScope("admin")).toBe("view");
    expect(parseEmbedScope("owner")).toBe("view");
  });

  it("is exact-match, not substring-match — 'editable' is not 'edit'", () => {
    // Guards against a future `.includes("edit")`-style rewrite being more
    // permissive than the literal contract.
    expect(parseEmbedScope("editable")).toBe("view");
    expect(parseEmbedScope("pre-edit")).toBe("view");
  });

  it("is case-sensitive — only the lowercase literal counts", () => {
    expect(parseEmbedScope("Edit")).toBe("view");
    expect(parseEmbedScope("EDIT")).toBe("view");
  });

  it("does not trim whitespace — padding is a malformed value, not 'edit'", () => {
    expect(parseEmbedScope(" edit")).toBe("view");
    expect(parseEmbedScope("edit ")).toBe("view");
  });

  it("rejects non-string types rather than coercing them", () => {
    expect(parseEmbedScope(1)).toBe("view");
    expect(parseEmbedScope(true)).toBe("view");
    expect(parseEmbedScope({})).toBe("view");
    expect(parseEmbedScope(["edit"])).toBe("view");
  });
});
