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

beforeEach(() => {
  jest.clearAllMocks();
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
  afterEach(() => {
    mockCurrentUser = { uid: "student1" };
  });

  it("throws when no user is signed in", async () => {
    mockCurrentUser = null;
    await expect(classroomService.enrollInClass("ABC123")).rejects.toThrow(/signed in/i);
    expect(getDocs).not.toHaveBeenCalled();
  });

  it("throws when the code matches no class", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await expect(classroomService.enrollInClass("ZZZZZZ")).rejects.toThrow(/no class found/i);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("reports alreadyEnrolled for an already-enrolled student without writing", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["class1", { joinCode: "ABC123", studentIds: ["student1"] }]])
    );
    const res = await classroomService.enrollInClass("abc123");
    expect(res).toEqual({ classId: "class1", alreadyEnrolled: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it("enrolls a new student via arrayUnion of their own uid only", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["class1", { joinCode: "ABC123", studentIds: [] }]])
    );
    const res = await classroomService.enrollInClass("abc123");
    expect(res).toEqual({ classId: "class1", alreadyEnrolled: false });
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ id: "class1" }),
      { studentIds: expect.objectContaining({ __type: "arrayUnion" }) }
    );
    expect(arrayUnion).toHaveBeenCalledWith("student1");
  });

  it("normalizes the input code (trim + uppercase) before querying", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    await expect(classroomService.enrollInClass("  abc123  ")).rejects.toThrow();
    const whereCall = (fs.where as jest.Mock).mock.calls.find((c) => c[0] === "joinCode");
    expect(whereCall[2]).toBe("ABC123");
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
});

describe("getInstructorClasses", () => {
  it("queries classes by instructorId", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["class1", { name: "CS 101", instructorId: "instructor1" }]])
    );
    const classes = await classroomService.getInstructorClasses("instructor1");
    expect(classes).toHaveLength(1);
    expect(classes[0].id).toBe("class1");
    expect((fs.where as jest.Mock)).toHaveBeenCalledWith("instructorId", "==", "instructor1");
  });
});

describe("isEnrolledStudent", () => {
  it("is true when the uid is in studentIds", () => {
    expect(classroomService.isEnrolledStudent({ studentIds: ["a", "b"] }, "b")).toBe(true);
  });

  it("is false when the uid is absent", () => {
    expect(classroomService.isEnrolledStudent({ studentIds: ["a", "b"] }, "c")).toBe(false);
  });
});

describe("attachBoardToClass", () => {
  it("updates only the board's classId", async () => {
    await classroomService.attachBoardToClass("board1", "class1");
    expect(updateDoc).toHaveBeenCalledWith(
      expect.objectContaining({ path: ["boards", "board1"] }),
      { classId: "class1" }
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
    expect((fs.where as jest.Mock)).toHaveBeenCalledWith("classId", "==", "class1");
  });

  it("returns an empty list when no board is submitted yet", async () => {
    getDocs.mockResolvedValueOnce(makeQuerySnap([]));
    expect(await classroomService.getClassBoards("class1")).toEqual([]);
  });

  it("defaults a missing title rather than surfacing undefined", async () => {
    getDocs.mockResolvedValueOnce(
      makeQuerySnap([["boardA", { ownerId: "student1" }]])
    );
    const boards = await classroomService.getClassBoards("class1");
    expect(boards[0].title).toBe("Untitled");
  });
});
