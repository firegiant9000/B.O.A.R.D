const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockPush })),
}));

jest.mock("../../../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../services/classroomService", () => ({
  getClass: jest.fn(),
  getClassBoards: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import InstructorCohortGrid from "../InstructorCohortGrid";
import { useAuth } from "../../../hooks/useAuth";
import { getClass, getClassBoards } from "../../../services/classroomService";
import type { ClassRoom } from "../../../types";

const mockUseAuth = useAuth as jest.Mock;
const mockGetClass = getClass as jest.Mock;
const mockGetClassBoards = getClassBoards as jest.Mock;

const INSTRUCTOR: ClassRoom = {
  id: "class1",
  name: "CS 101",
  instructorId: "instructor1",
  joinCode: "ABC123",
  studentIds: ["student1", "student2"],
  schemaVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function makeBoard(id: string, ownerId: string) {
  return { id, title: `${ownerId}'s board`, ownerId, updatedAt: new Date("2026-02-01T00:00:00Z") };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("InstructorCohortGrid", () => {
  it("shows a loading state before the class/boards resolve", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    let resolveClass: (v: ClassRoom) => void = () => {};
    mockGetClass.mockReturnValue(new Promise((r) => (resolveClass = r)));
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    expect(screen.getByTestId("cohort-grid-loading")).toBeTruthy();

    await act(async () => {
      resolveClass(INSTRUCTOR);
    });
  });

  it("renders the cohort grid for the class's own instructor, with every student's board", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockResolvedValue([
      makeBoard("boardA", "student1"),
      makeBoard("boardB", "student2"),
    ]);

    render(<InstructorCohortGrid classId="class1" />);

    await waitFor(() => expect(screen.getByTestId("cohort-grid")).toBeTruthy());
    expect(screen.getByText("CS 101")).toBeTruthy();
    expect(screen.getByTestId("cohort-board-boardA")).toBeTruthy();
    expect(screen.getByTestId("cohort-board-boardB")).toBeTruthy();
  });

  it("navigates to a board when its card is pressed", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockResolvedValue([makeBoard("boardA", "student1")]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-board-boardA")).toBeTruthy());

    fireEvent.press(screen.getByTestId("cohort-board-boardA"));
    expect(mockPush).toHaveBeenCalledWith("/board/boardA");
  });

  it("shows an empty state when no board has been submitted yet", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid")).toBeTruthy());
    expect(screen.getByText("No student boards submitted yet.")).toBeTruthy();
  });

  // Advisory-only affordance (see the component's own header): the real gate
  // is firestore.rules. This proves the UI doesn't show a half-empty/wrong
  // grid to a viewer who isn't this class's instructor, even if getClass
  // somehow still resolved a doc (e.g. the viewer is an enrolled student,
  // who CAN read the class doc per firestore.rules but is not its instructor).
  it("shows a forbidden state for a signed-in viewer who is not this class's instructor", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "student1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockResolvedValue([makeBoard("boardA", "student1")]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-forbidden")).toBeTruthy());
    expect(screen.queryByTestId("cohort-board-boardA")).toBeNull();
  });

  it("shows a forbidden state when the class doc can't be read at all (getClass -> null)", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "stranger1" } });
    mockGetClass.mockResolvedValue(null);
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-forbidden")).toBeTruthy());
  });

  it("shows an error state when loading fails", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    mockGetClass.mockRejectedValue(new Error("network down"));
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-error")).toBeTruthy());
  });
});
