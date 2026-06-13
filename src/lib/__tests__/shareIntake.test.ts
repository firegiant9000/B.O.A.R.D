import { classifyShare, handleSharedItem, placeSharedItem } from "../shareIntake";

describe("classifyShare", () => {
  it("classifies an image by mime type", () => {
    expect(classifyShare({ mimeType: "image/png", uri: "file:///a.png" })).toEqual({
      kind: "image",
      uri: "file:///a.png",
      mimeType: "image/png",
    });
  });

  it("classifies a pdf as a file", () => {
    expect(classifyShare({ mimeType: "application/pdf", uri: "file:///a.pdf", name: "a.pdf" })).toEqual({
      kind: "file",
      uri: "file:///a.pdf",
      mimeType: "application/pdf",
      name: "a.pdf",
    });
  });

  it("extracts a url out of shared text", () => {
    expect(classifyShare({ text: "check this https://board.example.org/b/BORD-AB12CD out" })).toEqual({
      kind: "link",
      url: "https://board.example.org/b/BORD-AB12CD",
    });
  });

  it("falls back to plain text", () => {
    expect(classifyShare({ text: "just a thought" })).toEqual({ kind: "text", text: "just a thought" });
  });

  it("returns null for an empty payload", () => {
    expect(classifyShare({})).toBeNull();
  });
});

describe("handleSharedItem", () => {
  it("routes a shared invite link to join-invite", () => {
    expect(handleSharedItem({ kind: "link", url: "https://board.example.org/b/bord-ab12cd" })).toEqual({
      action: "join-invite",
      inviteCode: "BORD-AB12CD",
    });
  });

  it("routes a shared board uri to open-board", () => {
    expect(handleSharedItem({ kind: "link", url: "boardapp://board/b1?session=s1" })).toEqual({
      action: "open-board",
      boardId: "b1",
      sessionId: "s1",
    });
  });

  it("marks non-board text as unsupported", () => {
    expect(handleSharedItem({ kind: "text", text: "hello" }).action).toBe("unsupported");
  });

  it("returns a place-image outcome for images (Phase 9 wiring)", () => {
    expect(handleSharedItem({ kind: "image", uri: "file:///a.png" })).toEqual({
      action: "place-image",
      uri: "file:///a.png",
    });
  });
});

describe("placeSharedItem", () => {
  it("reports not-placed until the Phase 9 pipeline exists", async () => {
    const res = await placeSharedItem("b1", { kind: "image", uri: "file:///a.png" });
    expect(res.placed).toBe(false);
    expect(res.reason).toMatch(/phase 9/i);
  });
});
