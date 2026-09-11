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
  // is firestore.rules. Fix round 1, I2 — confirmed empirically on the
  // emulator that a non-instructor's `getClassBoards` call is REJECTED
  // outright by firestore.rules (not silently filtered), so this test now
  // mocks it to REJECT (matching reality) rather than resolve, and asserts
  // the component never even calls it for a non-instructor — `load()`
  // gates that call on a confirmed instructor match from `getClass` first.
  it("shows a forbidden state for a signed-in viewer who is not this class's instructor, without ever calling getClassBoards", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "student1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockRejectedValue(new Error("permission-denied"));

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-forbidden")).toBeTruthy());
    expect(screen.queryByTestId("cohort-board-boardA")).toBeNull();
    expect(mockGetClassBoards).not.toHaveBeenCalled();
  });

  it("shows a forbidden state when the class doc can't be read at all (getClass -> null)", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "stranger1" } });
    mockGetClass.mockResolvedValue(null);
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-forbidden")).toBeTruthy());
    expect(mockGetClassBoards).not.toHaveBeenCalled();
  });

  // Fix round 1, I2 — a getClass REJECTION (denied read: not this class's
  // instructor or an enrolled student) is treated as "not accessible", the
  // same as a null result, never as a hard error — see the component's own
  // header for why.
  it("treats a getClass rejection as 'not accessible' (forbidden), not a hard error", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "stranger1" } });
    mockGetClass.mockRejectedValue(new Error("permission-denied"));
    mockGetClassBoards.mockResolvedValue([]);

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-forbidden")).toBeTruthy());
    expect(mockGetClassBoards).not.toHaveBeenCalled();
  });

  // "error" is reserved for a genuine failure hitting the CONFIRMED
  // instructor's own request — e.g. a network blip on getClassBoards after
  // getClass has already proven this caller is the instructor.
  it("shows an error state when the confirmed instructor's own getClassBoards call fails", async () => {
    mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
    mockGetClass.mockResolvedValue(INSTRUCTOR);
    mockGetClassBoards.mockRejectedValue(new Error("network down"));

    render(<InstructorCohortGrid classId="class1" />);
    await waitFor(() => expect(screen.getByTestId("cohort-grid-error")).toBeTruthy());
  });
});
