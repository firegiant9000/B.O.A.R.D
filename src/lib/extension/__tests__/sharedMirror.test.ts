import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

import { parseEmbedLink } from "../embedLink";
import { looksLikeEditScopeToken } from "../tokenScopeGuard";
import { isSendablePageUrl } from "../sendablePage";
import { parseDroppedItem, type DroppedItemInput } from "../droppedItem";
import { validateExtensionMessage, PAGE_METADATA_MESSAGE } from "../messages";
import { EDIT_ACTIONS_ENABLED } from "../editActionsGate";

/**
 * Month 6 — drift test for web/extension/shared.js.
 *
 * shared.js is a hand-mirrored, plain-JS port of the five tested modules
 * above (see its own header for why a bundler-free Manifest V3 extension
 * can't `import` them directly). Nothing else in this repo ever runs
 * shared.js, so a behavioral drift between it and its TypeScript originals
 * would otherwise be invisible to every other test here.
 *
 * This test actually EXECUTES shared.js — via Node's built-in `vm` module,
 * no new dependency — and runs the same fixture inputs used in this
 * directory's other *.test.ts files through both the TS original and the
 * executed JS twin, asserting identical output. That is strictly stronger
 * than a textual/source comparison: it catches real behavioral divergence,
 * not source-text similarity, which is the actual failure mode that matters
 * here (e.g. `looksLikeEditScopeToken` drifting between the tested module
 * and the copy that actually runs inside the extension). Same *purpose* as
 * the firestore.rules seat-cap / `MAX_DOT_VOTES` mirrors
 * (src/services/__tests__/pollService.test.ts,
 * src/lib/__tests__/planLimits.test.ts) — a value/behavior duplicated across
 * a boundary Jest can't otherwise cross — but a stronger technique than
 * theirs, because THOSE mirrors parse `firestore.rules` as text only because
 * the rules DSL genuinely cannot be executed under Jest. shared.js has no
 * such constraint: it is plain JS with no `import`/`export`/`chrome.*` at
 * module scope, so it can be loaded and actually run.
 *
 * `chrome.*`-touching code (background.js, content.js, and sidepanel.js's DOM
 * event wiring) is NOT covered here and can't be through this technique —
 * there is no `chrome` global or DOM to give the sandbox that would make
 * that code's real behavior observable outside an actual browser/extension
 * host. That is exactly why shared.js was designed to hold only the parts
 * that don't touch either: it is the one file in this extension `vm` can
 * safely execute standalone.
 */

const SHARED_JS_PATH = path.join(__dirname, "../../../../web/extension/shared.js");

interface SharedSandbox {
  parseEmbedLink: typeof parseEmbedLink;
  looksLikeEditScopeToken: typeof looksLikeEditScopeToken;
  isSendablePageUrl: typeof isSendablePageUrl;
  parseDroppedItem: typeof parseDroppedItem;
  validateExtensionMessage: typeof validateExtensionMessage;
  EDIT_ACTIONS_ENABLED: boolean;
  BOARD_ORIGIN: string;
  PAGE_METADATA_MESSAGE: string;
}

function loadSharedJs(): SharedSandbox {
  const source = fs.readFileSync(SHARED_JS_PATH, "utf8");
  // The only two browser globals shared.js's pure functions touch. Giving the
  // sandbox exactly these two (and nothing chrome/DOM-shaped) is what proves
  // shared.js's pure half genuinely doesn't depend on anything more.
  const sandbox: Record<string, unknown> = {
    URL,
    atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "shared.js" });
  return sandbox as unknown as SharedSandbox;
}

describe("web/extension/shared.js mirrors its tested TypeScript originals", () => {
  const shared = loadSharedJs();

  it("loaded successfully and exposes every mirrored export", () => {
    // Guard: if shared.js failed to parse/execute, or a rename dropped one of
    // these off the sandbox, every equality assertion below could otherwise
    // pass vacuously (both sides `undefined`).
    expect(typeof shared.parseEmbedLink).toBe("function");
    expect(typeof shared.looksLikeEditScopeToken).toBe("function");
    expect(typeof shared.isSendablePageUrl).toBe("function");
    expect(typeof shared.parseDroppedItem).toBe("function");
    expect(typeof shared.validateExtensionMessage).toBe("function");
    expect(typeof shared.EDIT_ACTIONS_ENABLED).toBe("boolean");
    expect(typeof shared.BOARD_ORIGIN).toBe("string");
    expect(shared.PAGE_METADATA_MESSAGE).toBe(PAGE_METADATA_MESSAGE);
  });

  it("EDIT_ACTIONS_ENABLED matches the TS original's value exactly", () => {
    expect(shared.EDIT_ACTIONS_ENABLED).toBe(EDIT_ACTIONS_ENABLED);
  });

  describe("parseEmbedLink", () => {
    const ORIGIN = "https://board-6b415.web.app";
    const cases: Array<[string, string]> = [
      [`${ORIGIN}/embed/b/board-1?token=tok123`, ORIGIN],
      [`  ${ORIGIN}/embed/b/board-1?token=tok123  `, ORIGIN],
      ["https://evil.example/embed/b/board-1?token=tok123", ORIGIN],
      [`${ORIGIN}/board/board-1?token=tok123`, ORIGIN],
      [`${ORIGIN}/embed/b/board-1`, ORIGIN],
      [`${ORIGIN}/embed/b/board-1?token=`, ORIGIN],
      ["not a url", ORIGIN],
      ["", ORIGIN],
      ["   ", ORIGIN],
      [`${ORIGIN}/embed/b/board-1/extra?token=tok123`, ORIGIN],
      [`${ORIGIN}/embed/b/board%201?token=tok123`, ORIGIN],
      [`${ORIGIN}/embed/b/board-1?token=tok123`, "not-a-url"],
    ];

    it.each(cases)("matches for link %j against origin %j", (input, origin) => {
      expect(shared.parseEmbedLink(input, origin)).toEqual(parseEmbedLink(input, origin));
    });
  });

  describe("looksLikeEditScopeToken", () => {
    function fakeToken(payload: unknown): string {
      const b64url = (s: string) =>
        Buffer.from(s, "utf-8")
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
        JSON.stringify(payload)
      )}.fake-signature`;
    }

    const tokens: string[] = [
      fakeToken({ v: 2, boardId: "b1", scope: "view" }),
      fakeToken({ v: 2, boardId: "b1", scope: "edit", sub: "u1", iss: "meet" }),
      fakeToken({ scope: "viewer" }),
      fakeToken({ scope: "pre-edit" }),
      fakeToken({ v: 2, boardId: "b1" }),
      "not.a.jwt.at.all",
      "onlyonepart",
      "two.parts",
      "aGVhZGVy.bm90LWpzb24.sig",
    ];

    it.each(tokens)("matches for token %j", (token) => {
      expect(shared.looksLikeEditScopeToken(token)).toBe(looksLikeEditScopeToken(token));
    });
  });

  describe("isSendablePageUrl", () => {
    const BOARD_ORIGIN_FIXTURE = "https://board-6b415.web.app";
    const urls: Array<string | undefined | null> = [
      "https://example.com/article",
      "http://example.com/",
      undefined,
      null,
      "",
      "not a url",
      "chrome://extensions",
      "edge://settings",
      "about:blank",
      "devtools://devtools/bundled/inspector.html",
      "chrome-extension://abcdefg/options.html",
      "data:text/plain,hello",
      `${BOARD_ORIGIN_FIXTURE}/embed/b/board-1?token=t`,
      `${BOARD_ORIGIN_FIXTURE}/`,
      "https://not-board-6b415.web.app/",
    ];

    it.each(urls)("matches for url %j", (url) => {
      expect(shared.isSendablePageUrl(url, BOARD_ORIGIN_FIXTURE)).toBe(
        isSendablePageUrl(url, BOARD_ORIGIN_FIXTURE)
      );
    });
  });

  describe("parseDroppedItem", () => {
    const inputs: DroppedItemInput[] = [
      {
        types: ["text/uri-list", "text/html"],
        uriList: "https://example.com/cat.png",
        html: '<img src="https://example.com/other.png">',
      },
      {
        types: ["text/uri-list"],
        uriList: "# a comment\n\nhttps://example.com/cat.png\nhttps://example.com/second.png",
      },
      {
        types: ["text/html"],
        html: '<div><img alt="x" src="https://example.com/pic.jpg" width="10"></div>',
      },
      { types: ["Files"], files: [{ name: "photo.png", type: "image/png" }] },
      { types: ["Files"], files: [{ name: "notes.pdf", type: "application/pdf" }] },
      { types: ["text/plain"] },
      { types: ["text/uri-list"], uriList: "\n\n  \n" },
      { types: ["text/html"], html: "<b>hello</b>" },
    ];

    it.each(inputs)("matches for input %j", (input) => {
      expect(shared.parseDroppedItem(input)).toEqual(parseDroppedItem(input));
    });
  });

  describe("validateExtensionMessage", () => {
    const messages: unknown[] = [
      {
        type: PAGE_METADATA_MESSAGE,
        url: "https://example.com/",
        title: "Example",
        image: "https://example.com/og.png",
      },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: "Example" },
      null,
      undefined,
      "a string",
      42,
      { type: "SOMETHING_ELSE", url: "https://example.com/", title: "x" },
      { type: PAGE_METADATA_MESSAGE, title: "x" },
      { type: PAGE_METADATA_MESSAGE, url: "", title: "x" },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/" },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: 123 },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: "x", image: 123 },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: "x", image: "" },
      { type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: "x", evil: "payload" },
    ];

    it.each(messages)("matches for message %j", (message) => {
      expect(shared.validateExtensionMessage(message)).toEqual(validateExtensionMessage(message));
    });
  });
});

describe("BOARD_ORIGIN literal stays in sync across its two hardcoded mirrors", () => {
  // BOARD_ORIGIN has no TypeScript source of truth to import — by design (see
  // both files' own headers) it is duplicated between this extension's
  // shared.js and the Google Meet add-on's panel.html. Same technique as the
  // firestore.rules seat-cap / MAX_DOT_VOTES mirrors: parse the literal out
  // of each file as TEXT, since there is no executable common source to
  // import here (panel.html is not a module either side can load), with a
  // guard so a regex that silently stops matching doesn't pass vacuously.
  it("matches between web/extension/shared.js and web/meet-addon/panel.html", () => {
    const sharedJs = fs.readFileSync(
      path.join(__dirname, "../../../../web/extension/shared.js"),
      "utf8"
    );
    const panelHtml = fs.readFileSync(
      path.join(__dirname, "../../../../web/meet-addon/panel.html"),
      "utf8"
    );

    const sharedMatch = sharedJs.match(/BOARD_ORIGIN\s*=\s*"([^"]+)"/);
    expect(sharedMatch).not.toBeNull(); // guard: parse must not silently match nothing
    const panelMatch = panelHtml.match(/BOARD_ORIGIN\s*=\s*"([^"]+)"/);
    expect(panelMatch).not.toBeNull(); // guard: parse must not silently match nothing

    expect(sharedMatch![1]).toBe(panelMatch![1]);
  });
});
