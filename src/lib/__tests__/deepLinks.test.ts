import {
  APP_SCHEME,
  buildBoardUri,
  buildInviteUrl,
  parseDeepLink,
  getLinkDomain,
  LINK_DOMAIN_PLACEHOLDER,
} from "../deepLinks";

describe("buildBoardUri", () => {
  it("builds the bare board uri", () => {
    expect(buildBoardUri("abc123")).toBe(`${APP_SCHEME}://board/abc123`);
  });

  it("appends the session query param when given", () => {
    expect(buildBoardUri("abc123", "sess9")).toBe(`${APP_SCHEME}://board/abc123?session=sess9`);
  });
});

describe("buildInviteUrl", () => {
  it("uses the placeholder domain by default", () => {
    expect(buildInviteUrl("BORD-AB12CD")).toBe(`https://${LINK_DOMAIN_PLACEHOLDER}/b/BORD-AB12CD`);
  });

  it("honors EXPO_PUBLIC_LINK_DOMAIN", () => {
    const prev = process.env.EXPO_PUBLIC_LINK_DOMAIN;
    process.env.EXPO_PUBLIC_LINK_DOMAIN = "board.example.org";
    expect(getLinkDomain()).toBe("board.example.org");
    expect(buildInviteUrl("BORD-AB12CD")).toBe("https://board.example.org/b/BORD-AB12CD");
    process.env.EXPO_PUBLIC_LINK_DOMAIN = prev;
  });
});

describe("parseDeepLink", () => {
  it("returns unknown for empty/garbage input", () => {
    expect(parseDeepLink(null).type).toBe("unknown");
    expect(parseDeepLink("").type).toBe("unknown");
    expect(parseDeepLink("https://example.com/about").type).toBe("unknown");
  });

  it("parses the custom-scheme board uri", () => {
    expect(parseDeepLink("boardapp://board/abc123")).toEqual({
      type: "board",
      boardId: "abc123",
      sessionId: undefined,
    });
  });

  it("parses the board uri with a session query param", () => {
    expect(parseDeepLink("boardapp://board/abc123?session=sess9")).toEqual({
      type: "board",
      boardId: "abc123",
      sessionId: "sess9",
    });
  });

  it("parses the https invite link and upper-cases the code", () => {
    expect(parseDeepLink("https://board.example.org/b/bord-ab12cd")).toEqual({
      type: "invite",
      inviteCode: "BORD-AB12CD",
    });
  });

  it("tolerates the expo-go dev deep-link prefix", () => {
    expect(parseDeepLink("exp://127.0.0.1:8081/--/board/xyz?session=s1")).toEqual({
      type: "board",
      boardId: "xyz",
      sessionId: "s1",
    });
  });

  it("round-trips its own builders", () => {
    expect(parseDeepLink(buildBoardUri("b1", "s1"))).toEqual({
      type: "board",
      boardId: "b1",
      sessionId: "s1",
    });
    expect(parseDeepLink(buildInviteUrl("BORD-XYZ123"))).toEqual({
      type: "invite",
      inviteCode: "BORD-XYZ123",
    });
  });
});
