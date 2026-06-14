import {
  mentionToken,
  extractMentionUids,
  tokenizeBody,
  toPlainText,
  findActiveMentionQuery,
  applyMention,
  filterMembers,
} from "../mentions";

const alice = { uid: "u-alice", displayName: "Alice" };
const bob = { uid: "u-bob", displayName: "Bob Lee" };

describe("mentionToken / extractMentionUids round-trip", () => {
  it("builds a token that parses back to the same uid", () => {
    const body = `Hey ${mentionToken(alice)} take a look`;
    expect(extractMentionUids(body)).toEqual(["u-alice"]);
  });

  it("extracts multiple distinct uids in first-seen order, deduped", () => {
    const body = `${mentionToken(bob)} ${mentionToken(alice)} again ${mentionToken(bob)}`;
    expect(extractMentionUids(body)).toEqual(["u-bob", "u-alice"]);
  });

  it("returns no uids for a plain body", () => {
    expect(extractMentionUids("no mentions here")).toEqual([]);
  });

  it("handles display names with spaces and adjacent tokens", () => {
    const body = `${mentionToken(bob)}${mentionToken(alice)}`;
    expect(extractMentionUids(body)).toEqual(["u-bob", "u-alice"]);
  });
});

describe("tokenizeBody", () => {
  it("splits text and mention segments in order", () => {
    const body = `Hi ${mentionToken(alice)}!`;
    expect(tokenizeBody(body)).toEqual([
      { type: "text", text: "Hi " },
      { type: "mention", uid: "u-alice", displayName: "Alice" },
      { type: "text", text: "!" },
    ]);
  });

  it("returns a single text segment when there are no mentions", () => {
    expect(tokenizeBody("plain")).toEqual([{ type: "text", text: "plain" }]);
  });
});

describe("toPlainText", () => {
  it("collapses tokens to @DisplayName", () => {
    expect(toPlainText(`ping ${mentionToken(bob)} now`)).toBe("ping @Bob Lee now");
  });
});

describe("findActiveMentionQuery", () => {
  it("detects an @query at the caret", () => {
    const text = "hey @al";
    expect(findActiveMentionQuery(text, text.length)).toEqual({ query: "al", start: 4 });
  });

  it("detects an empty query right after typing @", () => {
    const text = "hey @";
    expect(findActiveMentionQuery(text, text.length)).toEqual({ query: "", start: 4 });
  });

  it("returns null when a space follows the @", () => {
    const text = "hey @ ";
    expect(findActiveMentionQuery(text, text.length)).toBeNull();
  });

  it("returns null when the @ is mid-word (e.g. an email)", () => {
    const text = "mailto me@x";
    expect(findActiveMentionQuery(text, text.length)).toBeNull();
  });

  it("does not treat a completed token as an active query", () => {
    const text = `done ${mentionToken(alice)}`;
    expect(findActiveMentionQuery(text, text.length)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the active query with a token and a trailing space", () => {
    const text = "hey @al";
    const res = applyMention(text, text.length, alice);
    expect(res.text).toBe(`hey ${mentionToken(alice)} `);
    expect(res.caret).toBe(res.text.length);
    expect(extractMentionUids(res.text)).toEqual(["u-alice"]);
  });

  it("inserts mid-string and keeps the suffix", () => {
    const text = "a @b end";
    // caret right after "@b"
    const res = applyMention(text, 4, bob);
    expect(res.text).toBe(`a ${mentionToken(bob)}  end`);
  });

  it("is a no-op without an active query", () => {
    const text = "nothing to do";
    expect(applyMention(text, text.length, alice)).toEqual({ text, caret: text.length });
  });
});

describe("filterMembers", () => {
  const members = [alice, bob, { uid: "u-cara", displayName: "Cara" }];

  it("filters by case-insensitive substring", () => {
    expect(filterMembers(members, "bo").map((m) => m.uid)).toEqual(["u-bob"]);
  });

  it("excludes the author", () => {
    expect(filterMembers(members, "", "u-alice").map((m) => m.uid)).toEqual(["u-bob", "u-cara"]);
  });

  it("returns all (minus excluded) for an empty query", () => {
    expect(filterMembers(members, "")).toHaveLength(3);
  });
});
