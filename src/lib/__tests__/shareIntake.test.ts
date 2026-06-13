import { classifyShare, handleSharedItem, placeSharedItem } from "../shareIntake";
import { uploadImage } from "../../services/imageService";
import { PreparedImage } from "../images";

jest.mock("../../services/imageService", () => ({
  uploadImage: jest.fn(),
}));

const mockUploadImage = uploadImage as jest.MockedFunction<typeof uploadImage>;

function preparedImage(): PreparedImage {
  const blob = { size: 1 } as Blob;
  return {
    full: { blob, width: 200, height: 100 },
    thumbnail: { blob, width: 64, height: 32 },
    naturalWidth: 200,
    naturalHeight: 100,
    alt: "shared.png",
  };
}

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
  beforeEach(() => mockUploadImage.mockReset());

  it("uploads a prepared image aspect-fitted + centered, and returns its id", async () => {
    mockUploadImage.mockResolvedValue("img-1");
    const res = await placeSharedItem("b1", "u1", preparedImage(), { x: 500, y: 400 });

    expect(res).toEqual({ placed: true, imageId: "img-1" });
    expect(mockUploadImage).toHaveBeenCalledTimes(1);
    const [boardId, userId, prepared, placement] = mockUploadImage.mock.calls[0];
    expect(boardId).toBe("b1");
    expect(userId).toBe("u1");
    expect(prepared.alt).toBe("shared.png");
    // 200x100 source is under the 360px long-edge ceiling, so it is placed at its
    // natural size (placementBox never upscales), centered on (500,400).
    expect(placement.width).toBe(200);
    expect(placement.height).toBe(100);
    expect(placement.x).toBe(500 - 100);
    expect(placement.y).toBe(400 - 50);
    expect(placement.alt).toBe("shared.png");
  });

  it("reports not-placed with a reason when the upload fails", async () => {
    mockUploadImage.mockRejectedValue(new Error("storage down"));
    const res = await placeSharedItem("b1", "u1", preparedImage(), { x: 0, y: 0 });
    expect(res.placed).toBe(false);
    expect(res.reason).toMatch(/storage down/i);
  });
});
