jest.mock("../../../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../services/boardService", () => ({
  getBoard: jest.fn(),
}));

jest.mock("../../../services/classroomService", () => ({
  getClass: jest.fn(),
  getEnrolledClasses: jest.fn(),
  attachBoardToClass: jest.fn(),
  clearBoardClass: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import AttachToClassButton from "../AttachToClassButton";
import { useAuth } from "../../../hooks/useAuth";
import * as boardService from "../../../services/boardService";
import * as classroomService from "../../../services/classroomService";
import type { ClassRoom } from "../../../types";

const mockUseAuth = useAuth as jest.Mock;
const mockGetBoard = boardService.getBoard as jest.Mock;
const mockGetClass = classroomService.getClass as jest.Mock;
const mockGetEnrolledClasses = classroomService.getEnrolledClasses as jest.Mock;
const mockAttach = classroomService.attachBoardToClass as jest.Mock;
const mockClear = classroomService.clearBoardClass as jest.Mock;

function makeClass(overrides: Partial<ClassRoom> = {}): ClassRoom {
  return {
    id: "class1",
    name: "CS 101",
    instructorId: "instructor1",
    joinCode: "ABC123",
    studentIds: ["student1"],
    schemaVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeBoard(overrides: Record<string, unknown> = {}) {
  return {
    id: "board1",
    workspaceId: "ws1",
    title: "My board",
    ownerId: "student1",
    adminId: "student1",
    collaboratorIds: [],
    inviteCode: "",
    members: ["student1"],
    roles: {},
    backgroundTemplate: "blank",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { uid: "student1" } });
});

describe("AttachToClassButton", () => {
  it("renders nothing for a non-admin", () => {
    render(<AttachToClassButton boardId="board1" isAdmin={false} />);
    expect(screen.queryByTestId("attach-to-class")).toBeNull();
    expect(screen.queryByTestId("attach-to-class-loading")).toBeNull();
    expect(mockGetBoard).not.toHaveBeenCalled();
  });

  it("shows a loading state before the board resolves", async () => {
    let resolveBoard: (v: unknown) => void = () => {};
    mockGetBoard.mockReturnValue(new Promise((r) => (resolveBoard = r)));

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);
    expect(screen.getByTestId("attach-to-class-loading")).toBeTruthy();

    resolveBoard(makeBoard());
    mockGetEnrolledClasses.mockResolvedValue([]);
    await waitFor(() => expect(screen.getByTestId("attach-to-class")).toBeTruthy());
  });

  it("offers every enrolled class as an attach option when the board has no classId yet", async () => {
    mockGetBoard.mockResolvedValue(makeBoard({ classId: undefined }));
    mockGetEnrolledClasses.mockResolvedValue([makeClass(), makeClass({ id: "class2", name: "Bio 201" })]);

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);

    await waitFor(() => expect(screen.getByTestId("attach-to-class-option-class1")).toBeTruthy());
    expect(screen.getByTestId("attach-to-class-option-class2")).toBeTruthy();
    expect(screen.getByText("Submit to CS 101")).toBeTruthy();
  });

  it("shows a 'none enrolled' hint when the board has no classId and the user is enrolled nowhere", async () => {
    mockGetBoard.mockResolvedValue(makeBoard({ classId: undefined }));
    mockGetEnrolledClasses.mockResolvedValue([]);

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);
    await waitFor(() => expect(screen.getByTestId("attach-to-class-none")).toBeTruthy());
  });

  it("attaches the board to the chosen class, wiring I1's attach flow to real UI", async () => {
    mockGetBoard
      .mockResolvedValueOnce(makeBoard({ classId: undefined }))
      .mockResolvedValueOnce(makeBoard({ classId: "class1" }));
    mockGetEnrolledClasses.mockResolvedValue([makeClass()]);
    mockAttach.mockResolvedValue(undefined);
    mockGetClass.mockResolvedValue(makeClass());

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);
    await waitFor(() => expect(screen.getByTestId("attach-to-class-option-class1")).toBeTruthy());

    fireEvent.press(screen.getByTestId("attach-to-class-option-class1"));

    await waitFor(() => expect(mockAttach).toHaveBeenCalledWith("board1", "class1"));
    await waitFor(() => expect(screen.getByTestId("attach-to-class-attached")).toBeTruthy());
    expect(screen.getByText("Submitted to CS 101")).toBeTruthy();
  });

  it("shows a pinned 'Submitted to' badge when the board already has a classId whose class exists", async () => {
    mockGetBoard.mockResolvedValue(makeBoard({ classId: "class1" }));
    mockGetClass.mockResolvedValue(makeClass());

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);

    await waitFor(() => expect(screen.getByTestId("attach-to-class-attached")).toBeTruthy());
    expect(screen.getByText("Submitted to CS 101")).toBeTruthy();
    expect(mockGetEnrolledClasses).not.toHaveBeenCalled();
  });

  it("offers a Clear affordance when the attached class has been deleted (fix round 1, I3)", async () => {
    mockGetBoard
      .mockResolvedValueOnce(makeBoard({ classId: "class1" }))
      .mockResolvedValueOnce(makeBoard({ classId: undefined }));
    mockGetClass.mockResolvedValue(null);
    mockClear.mockResolvedValue(undefined);
    mockGetEnrolledClasses.mockResolvedValue([]);

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);
    await waitFor(() => expect(screen.getByTestId("attach-to-class-deleted")).toBeTruthy());

    fireEvent.press(screen.getByTestId("attach-to-class-clear"));
    await waitFor(() => expect(mockClear).toHaveBeenCalledWith("board1"));
    await waitFor(() => expect(screen.getByTestId("attach-to-class-none")).toBeTruthy());
  });

  it("shows an error state when loading fails", async () => {
    mockGetBoard.mockRejectedValue(new Error("network down"));

    render(<AttachToClassButton boardId="board1" isAdmin={true} />);
    await waitFor(() => expect(screen.getByText(/Couldn't load class info/)).toBeTruthy());
  });
});
