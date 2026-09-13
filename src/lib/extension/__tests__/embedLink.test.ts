import { parseEmbedLink } from "../embedLink";

const ORIGIN = "https://board-6b415.web.app";

// Matches the shape `embedPath` (src/services/embedService.ts) produces —
// `/embed/b/{boardId}?token={token}` — reproduced literally here rather than
// imported, so this pure-parsing test doesn't have to pull in and mock the
// real Firebase SDK that embedService.ts's other export (`createEmbedLink`)
// transitively imports.
function linkFor(boardId: string, token: string): string {
  return `/embed/b/${boardId}?token=${encodeURIComponent(token)}`;
}

describe("parseEmbedLink", () => {
  it("parses a well-formed embed link for the configured origin", () => {
    const result = parseEmbedLink(`${ORIGIN}${linkFor("board-1", "tok123")}`, ORIGIN);
    expect(result).toEqual({ boardId: "board-1", token: "tok123" });
  });

  it("trims surrounding whitespace before parsing", () => {
    const result = parseEmbedLink(`  ${ORIGIN}${linkFor("board-1", "tok123")}  `, ORIGIN);
    expect(result).toEqual({ boardId: "board-1", token: "tok123" });
  });

  it("rejects a link on a different origin", () => {
    const result = parseEmbedLink(
      `https://evil.example${linkFor("board-1", "tok123")}`,
      ORIGIN
    );
    expect(result).toBeNull();
  });

  it("rejects a same-origin link with a different path", () => {
    expect(parseEmbedLink(`${ORIGIN}/board/board-1?token=tok123`, ORIGIN)).toBeNull();
  });

  it("rejects a link missing the token query param", () => {
    expect(parseEmbedLink(`${ORIGIN}/embed/b/board-1`, ORIGIN)).toBeNull();
  });

  it("rejects a link with an empty token", () => {
    expect(parseEmbedLink(`${ORIGIN}/embed/b/board-1?token=`, ORIGIN)).toBeNull();
  });

  it("rejects unparsable input", () => {
    expect(parseEmbedLink("not a url", ORIGIN)).toBeNull();
    expect(parseEmbedLink("", ORIGIN)).toBeNull();
    expect(parseEmbedLink("   ", ORIGIN)).toBeNull();
  });

  it("rejects a nested path that merely starts with the embed prefix", () => {
    // Guards against a future `.startsWith`-style rewrite of the path check
    // being more permissive than the exact shape `embedPath` produces.
    expect(parseEmbedLink(`${ORIGIN}/embed/b/board-1/extra?token=tok123`, ORIGIN)).toBeNull();
  });

  it("decodes a percent-encoded board id", () => {
    const result = parseEmbedLink(`${ORIGIN}/embed/b/board%201?token=tok123`, ORIGIN);
    expect(result).toEqual({ boardId: "board 1", token: "tok123" });
  });

  it("returns null when boardOrigin itself is unparsable", () => {
    expect(parseEmbedLink(`${ORIGIN}${linkFor("board-1", "tok123")}`, "not-a-url")).toBeNull();
  });
});
