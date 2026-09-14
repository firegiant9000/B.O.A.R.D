jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("../../config/firebase", () => ({ db: {}, storage: {}, auth: { currentUser: null } }));
jest.mock("firebase/storage", () => ({
  ref: jest.fn((_s: unknown, path: string) => ({ __type: "storageRef", path })),
  uploadBytes: jest.fn(async () => ({})),
  getDownloadURL: jest.fn(async (r: { path: string }) => `https://dl/${r.path}`),
  deleteObject: jest.fn(async () => undefined),
}));

import * as fs from "firebase/firestore";
import * as storage from "firebase/storage";
import { makeQuerySnap, ts } from "../../test-utils/firestoreMock";
import * as audioService from "../audioService";
import { saveVoiceNote, deleteVoiceNote } from "../audioService";

const setDoc = fs.setDoc as jest.Mock;
const getDocs = fs.getDocs as jest.Mock;
const deleteDoc = fs.deleteDoc as jest.Mock;
const uploadBytes = storage.uploadBytes as jest.Mock;
const deleteObject = storage.deleteObject as jest.Mock;

const originalFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({ blob: async () => ({ size: 1 } as unknown as Blob) })) as unknown as typeof fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

// --- Task 16 brief, Step 1 literal tests ---

it("rejects a recording longer than the cap", async () => {
  await expect(
    saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 61_000 })
  ).rejects.toThrow(/60/);
});

it("deletes the storage object when the element is deleted", async () => {
  await deleteVoiceNote("b1", "audio1");
  expect(deleteObject).toHaveBeenCalled();
});

// --- Additional coverage ---

describe("saveVoiceNote", () => {
  it("accepts a recording at exactly the 60s cap", async () => {
    const id = await saveVoiceNote({
      boardId: "b1",
      anchorElementId: "e1",
      uri: "file://x",
      durationMs: 60_000,
    });
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it("uploads to boards/{boardId}/audio/{audioId}/note.m4a with a registered audio MIME type", async () => {
    const id = await saveVoiceNote({
      boardId: "b1",
      anchorElementId: "e1",
      uri: "file://x",
      durationMs: 5_000,
    });
    expect(uploadBytes).toHaveBeenCalledTimes(1);
    const [ref, , options] = uploadBytes.mock.calls[0];
    expect(ref.path).toBe(`boards/b1/audio/${id}/note.m4a`);
    // "audio/m4a" isn't a registered MIME type; players expect audio/mp4 (or
    // audio/x-m4a) as the Content-Type for an .m4a file. Either way it must
    // still satisfy storage.rules' isValidAudioUpload `audio/.*` match.
    expect(options).toEqual({ contentType: "audio/mp4" });
    expect((options as { contentType: string }).contentType).toMatch(/^audio\//);
  });

  it("writes a Firestore doc carrying schemaVersion 1, the anchor id, and the resolved download URL", async () => {
    await saveVoiceNote({
      boardId: "b1",
      anchorElementId: "e1",
      uri: "file://x",
      durationMs: 5_000,
      userId: "u1",
      x: 12,
      y: 34,
    });
    const path = setDoc.mock.calls[0][0].path;
    expect(path).toEqual(["boards", "b1", "audio", expect.any(String)]);
    const payload = setDoc.mock.calls[0][1];
    expect(payload).toMatchObject({
      schemaVersion: 1,
      boardId: "b1",
      userId: "u1",
      anchorElementId: "e1",
      durationMs: 5_000,
      x: 12,
      y: 34,
    });
    expect(payload.storagePath).toMatch(/^boards\/b1\/audio\/.+\/note\.m4a$/);
    expect(payload.downloadUrl).toContain("https://dl/");
    expect(payload.createdAt).toBe("__serverTimestamp__");
  });

  it("rejects before touching Storage or Firestore when over the cap", async () => {
    await expect(
      saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 60_001 })
    ).rejects.toThrow(/60/);
    expect(uploadBytes).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  // Item 3, fix round 1: firestore.rules' `audio` match only allows an
  // editor to write the doc, while storage.rules' matching block allows any
  // board member to upload — so a doc-write denial (a viewer somehow
  // reaching this, or a real permission error) must not strand the bytes
  // that already landed in Storage.
  it("deletes the just-uploaded Storage object when the doc write fails", async () => {
    setDoc.mockRejectedValueOnce(new Error("permission-denied"));
    await expect(
      saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 5_000 })
    ).rejects.toThrow(/permission-denied/);
    expect(uploadBytes).toHaveBeenCalledTimes(1);
    const uploadedPath = uploadBytes.mock.calls[0][0].path;
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject.mock.calls[0][0].path).toBe(uploadedPath);
  });

  it("deletes the just-uploaded Storage object when resolving the download URL fails", async () => {
    (storage.getDownloadURL as jest.Mock).mockRejectedValueOnce(new Error("network error"));
    await expect(
      saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 5_000 })
    ).rejects.toThrow(/network error/);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it("still rejects with the original error even if the Storage cleanup itself fails", async () => {
    setDoc.mockRejectedValueOnce(new Error("permission-denied"));
    deleteObject.mockRejectedValueOnce(new Error("cleanup also failed"));
    await expect(
      saveVoiceNote({ boardId: "b1", anchorElementId: "e1", uri: "file://x", durationMs: 5_000 })
    ).rejects.toThrow(/permission-denied/);
  });
});

describe("deleteVoiceNote", () => {
  it("deletes the doc and the well-known storage object for that id", async () => {
    await deleteVoiceNote("b1", "audio1");
    expect(deleteDoc.mock.calls[0][0].path).toEqual(["boards", "b1", "audio", "audio1"]);
    expect(deleteObject.mock.calls[0][0].path).toBe("boards/b1/audio/audio1/note.m4a");
  });

  it("is best-effort: a missing Storage object does not reject the call", async () => {
    deleteObject.mockRejectedValueOnce(new Error("object-not-found"));
    await expect(deleteVoiceNote("b1", "audio1")).resolves.toBeUndefined();
  });
});

describe("group delete / clear board (orphan fix)", () => {
  it("batchDeleteVoiceNotes deletes each doc and its storage object", async () => {
    const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await audioService.batchDeleteVoiceNotes("b1", ["a1", "a2"]);
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const paths = deleteObject.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["boards/b1/audio/a1/note.m4a", "boards/b1/audio/a2/note.m4a"]);
  });

  it("is a no-op on empty input", async () => {
    await audioService.batchDeleteVoiceNotes("b1", []);
    expect(fs.writeBatch).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("clearBoardVoiceNotes deletes every doc's storage object, not just the docs", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["a1", {}], ["a2", {}]]));
    const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);
    await audioService.clearBoardVoiceNotes("b1");
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const paths = deleteObject.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["boards/b1/audio/a1/note.m4a", "boards/b1/audio/a2/note.m4a"]);
  });

  it("clearBoardVoiceNotes is a no-op when the board has no voice notes", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await audioService.clearBoardVoiceNotes("b1");
    expect(fs.writeBatch).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

describe("subscribeToBoardAudio", () => {
  it("maps docs and drops one missing required fields", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(
        makeQuerySnap([
          [
            "a1",
            {
              boardId: "b1",
              userId: "u1",
              anchorElementId: "e1",
              storagePath: "boards/b1/audio/a1/note.m4a",
              downloadUrl: "https://dl/note",
              durationMs: 5000,
              x: 1,
              y: 2,
              createdAt: ts(new Date()),
            },
          ],
          ["bad", { boardId: "b1" }], // missing anchorElementId/downloadUrl
        ])
      );
      return unsub;
    });
    const onChange = jest.fn();
    const returned = audioService.subscribeToBoardAudio("b1", onChange);
    const emitted = onChange.mock.calls[0][0];
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ id: "a1", schemaVersion: 1, anchorElementId: "e1" });
    expect(returned).toBe(unsub);
  });

  // Item 7, fix round 1: x/y are a write-time snapshot the live canvas no
  // longer trusts for the badge's position (derived from the anchor's
  // current bounds instead) — a doc missing them is still a usable note,
  // not a malformed one that should be dropped.
  it("maps a doc missing x/y (defaults to 0), unlike a doc missing anchorElementId/storagePath/downloadUrl", () => {
    const unsub = jest.fn();
    (fs.onSnapshot as jest.Mock).mockImplementationOnce((_q, cb) => {
      cb(
        makeQuerySnap([
          [
            "a1",
            {
              boardId: "b1",
              userId: "u1",
              anchorElementId: "e1",
              storagePath: "boards/b1/audio/a1/note.m4a",
              downloadUrl: "https://dl/note",
              durationMs: 5000,
              createdAt: ts(new Date()),
              // x/y intentionally absent
            },
          ],
        ])
      );
      return unsub;
    });
    const onChange = jest.fn();
    audioService.subscribeToBoardAudio("b1", onChange);
    const emitted = onChange.mock.calls[0][0];
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ id: "a1", x: 0, y: 0 });
  });
});

describe("canRecordVoiceNotes (advisory Pro gate)", () => {
  it("denies the free plan", () => {
    expect(audioService.canRecordVoiceNotes("free")).toBe(false);
  });

  it("allows pro and edu", () => {
    expect(audioService.canRecordVoiceNotes("pro")).toBe(true);
    expect(audioService.canRecordVoiceNotes("edu")).toBe(true);
  });

  // Mirrors `canUsePresenter`'s own undefined case exactly (see
  // workspaceService.test.ts) — `undefined` means the caller does not yet
  // KNOW the plan, which is a different fact from "known to be on the free
  // plan," and must fail OPEN. `useBoardDocument.ts` sets `boardWorkspace`
  // to `null` on a `getWorkspace` rejection and `loadBoard` runs once per
  // boardId with no retry, so coercing that to `"free"` showed a paying
  // customer a locked mic for the whole board session — and every board
  // load showed it transiently, before the fetch resolved.
  it("is true for an unknown plan (undefined) — fails open, unlike the free plan", () => {
    expect(audioService.canRecordVoiceNotes(undefined)).toBe(true);
  });
});

describe("deleteVoiceNotesForElements (anchor cascade)", () => {
  it("deletes only the notes anchored to one of the given element ids", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["a1", { anchorElementId: "stroke-1" }],
        ["a2", { anchorElementId: "stroke-2" }],
        ["a3", { anchorElementId: "shape-9" }],
      ])
    );
    const batch = { delete: jest.fn(), update: jest.fn(), commit: jest.fn(async () => undefined) };
    (fs.writeBatch as jest.Mock).mockReturnValueOnce(batch);

    await audioService.deleteVoiceNotesForElements("b1", ["stroke-1", "shape-9", "never-anchored"]);

    // Exact doc ids deleted: a1 (stroke-1) and a3 (shape-9), not a2 (stroke-2).
    expect(batch.delete).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    const paths = deleteObject.mock.calls.map((c) => c[0].path).sort();
    expect(paths).toEqual(["boards/b1/audio/a1/note.m4a", "boards/b1/audio/a3/note.m4a"]);
  });

  // Coordinator's explicit ask: prove the lookup doesn't fire spuriously.
  it("performs no Storage or Firestore deletes when no note is anchored to any given id", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["a1", { anchorElementId: "stroke-1" }]])
    );
    await audioService.deleteVoiceNotesForElements("b1", ["some-other-element"]);
    expect(fs.writeBatch).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("is a no-op on empty input — never even reads the audio collection", async () => {
    await audioService.deleteVoiceNotesForElements("b1", []);
    expect(getDocs).not.toHaveBeenCalled();
    expect(fs.writeBatch).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("is a no-op when the board has no voice notes at all", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await audioService.deleteVoiceNotesForElements("b1", ["stroke-1"]);
    expect(fs.writeBatch).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
