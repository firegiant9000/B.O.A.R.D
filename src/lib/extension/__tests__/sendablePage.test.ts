import { isSendablePageUrl } from "../sendablePage";

const BOARD_ORIGIN = "https://board-6b415.web.app";

describe("isSendablePageUrl", () => {
  it("accepts an ordinary https page", () => {
    expect(isSendablePageUrl("https://example.com/article", BOARD_ORIGIN)).toBe(true);
  });

  it("accepts an ordinary http page", () => {
    expect(isSendablePageUrl("http://example.com/", BOARD_ORIGIN)).toBe(true);
  });

  it("rejects a missing or empty url", () => {
    expect(isSendablePageUrl(undefined, BOARD_ORIGIN)).toBe(false);
    expect(isSendablePageUrl(null, BOARD_ORIGIN)).toBe(false);
    expect(isSendablePageUrl("", BOARD_ORIGIN)).toBe(false);
  });

  it("rejects unparsable input", () => {
    expect(isSendablePageUrl("not a url", BOARD_ORIGIN)).toBe(false);
  });

  it("rejects browser-internal schemes", () => {
    expect(isSendablePageUrl("chrome://extensions", BOARD_ORIGIN)).toBe(false);
    expect(isSendablePageUrl("edge://settings", BOARD_ORIGIN)).toBe(false);
    expect(isSendablePageUrl("about:blank", BOARD_ORIGIN)).toBe(false);
    expect(isSendablePageUrl("devtools://devtools/bundled/inspector.html", BOARD_ORIGIN)).toBe(
      false
    );
    expect(
      isSendablePageUrl("chrome-extension://abcdefg/options.html", BOARD_ORIGIN)
    ).toBe(false);
    expect(isSendablePageUrl("data:text/plain,hello", BOARD_ORIGIN)).toBe(false);
  });

  it("rejects the board app's own origin", () => {
    expect(isSendablePageUrl(`${BOARD_ORIGIN}/embed/b/board-1?token=t`, BOARD_ORIGIN)).toBe(
      false
    );
    expect(isSendablePageUrl(`${BOARD_ORIGIN}/`, BOARD_ORIGIN)).toBe(false);
  });

  it("does not reject other pages merely because they share a path segment with the board origin", () => {
    // Guards against a substring/`.includes` rewrite of the origin check.
    expect(isSendablePageUrl("https://not-board-6b415.web.app/", BOARD_ORIGIN)).toBe(true);
  });

  it("falls back to the scheme check when boardOrigin itself is unparsable", () => {
    expect(isSendablePageUrl("https://example.com/", "not-a-url")).toBe(true);
  });
});
