jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

let mockCurrentUser: { uid: string } | null = { uid: "student1" };
jest.mock("../../config/firebase", () => ({
  db: {},
  get auth() {
    return { currentUser: mockCurrentUser };
  },
  functions: {},
}));

const mockCallable = jest.fn();
const mockHttpsCallable = jest.fn((..._args: unknown[]) => mockCallable);
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockHttpsCallable(...args),
}));

import * as fs from "firebase/firestore";
import { makeQuerySnap, makeDocSnap, ts } from "../../test-utils/firestoreMock";
import * as classroomService from "../classroomService";

const getDocs = fs.getDocs as jest.Mock;
const getDoc = fs.getDoc as jest.Mock;
const updateDoc = fs.updateDoc as jest.Mock;
const arrayUnion = fs.arrayUnion as jest.Mock;
const arrayRemove = fs.arrayRemove as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = { uid: "student1" };
});

describe("createClass", () => {
  // Class creation is Cloud-Function-only (functions/src/callable/
  // createClass.ts): firestore.rules denies a direct client create outright,
  // so the callable is the only path. That the join code is actually
  // server-generated is covered server-side
  // (functions/src/__tests__/createClass.test.ts) and in the rules suite;
  // this file only covers what this function itself sends and returns.
  it("calls the createClass callable and returns its response", async () => {
    mockCallable.mockResolvedValueOnce({ data: { classId: "class1", joinCode: "ABC123" } });

    const res = await classroomService.createClass("CS 101");

    expect(res).toEqual({ classId: "class1", joinCode: "ABC123" });
    expect(mockCallable).toHaveBeenCalledWith({ name: "CS 101" });
  });

  it('binds httpsCallable to the "createClass" function name', async () => {
    // Pins the callable's name against the mock factory's own second
    // argument, not just the configured return value — a typo here (e.g.
    // "createclass") would still satisfy every other assertion while
    // breaking every class create in production.
    mockCallable.mockResolvedValueOnce({ data: { classId: "class1", joinCode: "ABC123" } });

    await classroomService.createClass("CS 101");

    expect(mockHttpsCallable).toHaveBeenCalled();
    expect(mockHttpsCallable.mock.calls[0][1]).toBe("createClass");
  });
});

describe("enrollInClass", () => {
  it("throws when no user is signed in", async () => {
    mockCurrentUser = null;
    await expect(classroomService.enrollInClass("ABC123")).rejects.toThrow(/signed in/i);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it("throws when the join code matches nothing in the joinCodes lookup", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ZZZZZZ", null));
    await expect(classroomService.enrollInClass("ZZZZZZ")).rejects.toThrow(/no class found/i);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("resolves the code via the joinCodes/{code} doc, then self-enrolls by uid only", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ABC123", { classId: "class1" }));

    const res = await classroomService.enrollInClass("abc123");

    expect(res).toEqual({ classId: "class1" });
    // Resolved via a plain getDoc by ID — never a `where('joinCode',...)`
    // query against the classes collection (fix round 1, I4: the class
    // roster is no longer exposed by the lookup path at all).
    expect(getDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["joinCodes", "ABC123"] })
    );
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["classes", "class1"] }),
      expect.objectContaining({ studentIds: expect.objectContaining({ __type: "arrayUnion" }) })
    );
    expect(arrayUnion).toHaveBeenCalledWith("student1");
  });

  it("bumps updatedAt on the self-enroll write", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ABC123", { classId: "class1" }));
    await classroomService.enrollInClass("ABC123");
    const [, payload] = updateDoc.mock.calls[0];
    expect(payload.updatedAt).toBe("__serverTimestamp__");
  });

  it("normalizes the input code (trim + uppercase) before the lookup", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ABC123", { classId: "class1" }));
    await classroomService.enrollInClass("  abc123  ");
    expect(getDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["joinCodes", "ABC123"] })
    );
  });

  it("performs no prior read of the class doc itself — only the joinCodes lookup then the write", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("ABC123", { classId: "class1" }));
    await classroomService.enrollInClass("ABC123");
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(getDocs).not.toHaveBeenCalled();
  });
});

describe("getClass", () => {
  it("returns null when the class doesn't exist", async () => {
    getDoc.mockResolvedValueOnce(makeDocSnap("class1", null));
    expect(await classroomService.getClass("class1")).toBeNull();
  });

  it("maps a found class doc, defaulting missing fields safely", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("class1", {
        name: "CS 101",
        instructorId: "instructor1",
        joinCode: "ABC123",
        studentIds: ["student1"],
        createdAt: ts(new Date("2026-01-01T00:00:00Z")),
      })
    );
    const klass = await classroomService.getClass("class1");
    expect(klass).toMatchObject({
      id: "class1",
      name: "CS 101",
      instructorId: "instructor1",
      joinCode: "ABC123",
      studentIds: ["student1"],
      schemaVersion: 1,
    });
  });

  // Fix round 1, M2 — schemaVersion reads the STORED value rather than
  // hardcoding 1, so a future v2 document isn't silently mislabelled.
  it("preserves a stored schemaVersion instead of hardcoding 1", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("class1", { name: "CS 101", instructorId: "instructor1", schemaVersion: 2 })
    );
    const klass = await classroomService.getClass("class1");
    expect(klass?.schemaVersion).toBe(2);
  });

  it("defaults schemaVersion to 1 when absent (legacy/migration-tolerant)", async () => {
    getDoc.mockResolvedValueOnce(
      makeDocSnap("class1", { name: "CS 101", instructorId: "instructor1" })
    );
    const klass = await classroomService.getClass("class1");
    expect(klass?.schemaVersion).toBe(1);
  });
});

describe("getInstructorClasses", () => {
  it("queries classes by instructorId", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["class1", { name: "CS 101", instructorId: "instructor1" }]])
    );
    const classes = await classroomService.getInstructorClasses("instructor1");
    expect(classes).toHaveLength(1);
    expect(classes[0].id).toBe("class1");
    expect(fs.where as jest.Mock).toHaveBeenCalledWith("instructorId", "==", "instructor1");
  });
});

describe("getEnrolledClasses", () => {
  it("queries classes by a studentIds array-contains filter", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["class1", { name: "CS 101", instructorId: "instructor1" }]])
    );
    const classes = await classroomService.getEnrolledClasses("student1");
    expect(classes).toHaveLength(1);
    expect(classes[0].id).toBe("class1");
    expect(fs.where as jest.Mock).toHaveBeenCalledWith("studentIds", "array-contains", "student1");
  });

  it("returns an empty list when enrolled in nothing", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await classroomService.getEnrolledClasses("student1")).toEqual([]);
  });
});

describe("removeStudentFromClass", () => {
  // Fix round 1, I3 — the instructor's roster-cleanup lever.
  it("removes exactly the named uid via arrayRemove, and bumps updatedAt", async () => {
    await classroomService.removeStudentFromClass("class1", "student2");
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["classes", "class1"] }),
      expect.objectContaining({
        studentIds: expect.objectContaining({ __type: "arrayRemove" }),
        updatedAt: "__serverTimestamp__",
      })
    );
    expect(arrayRemove).toHaveBeenCalledWith("student2");
  });
});

describe("attachBoardToClass", () => {
  it("updates the board's classId and bumps updatedAt in the same write", async () => {
    await classroomService.attachBoardToClass("board1", "class1");
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["boards", "board1"] }),
      { classId: "class1", updatedAt: "__serverTimestamp__" }
    );
  });
});

describe("clearBoardClass", () => {
  // Fix round 1, I3 — the ONE way classId may move off a real value once
  // set (guarded server-side by classIdTransitionValid's exists() check).
  it("sets the board's classId to null and bumps updatedAt", async () => {
    await classroomService.clearBoardClass("board1");
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["boards", "board1"] }),
      { classId: null, updatedAt: "__serverTimestamp__" }
    );
  });
});

describe("getClassBoards", () => {
  it("queries boards by classId and maps a lightweight summary", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([
        ["boardA", { title: "Alice's board", ownerId: "student1", updatedAt: ts(new Date("2026-02-01T00:00:00Z")) }],
        ["boardB", { title: "Bob's board", ownerId: "student2", updatedAt: ts(new Date("2026-02-02T00:00:00Z")) }],
      ])
    );
    const boards = await classroomService.getClassBoards("class1");
    expect(boards).toHaveLength(2);
    expect(boards.map((b) => b.id)).toEqual(["boardA", "boardB"]);
    expect(boards[0]).toMatchObject({ title: "Alice's board", ownerId: "student1" });
    expect(fs.where as jest.Mock).toHaveBeenCalledWith("classId", "==", "class1");
  });

  it("returns an empty list when no board is submitted yet", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await classroomService.getClassBoards("class1")).toEqual([]);
  });

  it("defaults a missing title rather than surfacing undefined", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([["boardA", { ownerId: "student1" }]]));
    const boards = await classroomService.getClassBoards("class1");
    expect(boards[0].title).toBe("Untitled");
  });
});
