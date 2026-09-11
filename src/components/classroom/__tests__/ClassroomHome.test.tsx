const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: jest.fn(() => ({ push: mockPush })),
}));

jest.mock("../../../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

jest.mock("../../../services/classroomService", () => ({
  getInstructorClasses: jest.fn(),
  getEnrolledClasses: jest.fn(),
  createClass: jest.fn(),
  enrollInClass: jest.fn(),
  removeStudentFromClass: jest.fn(),
}));

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import ClassroomHome from "../ClassroomHome";
import { useAuth } from "../../../hooks/useAuth";
import * as classroomService from "../../../services/classroomService";
import type { ClassRoom } from "../../../types";

const mockUseAuth = useAuth as jest.Mock;
const mockGetInstructorClasses = classroomService.getInstructorClasses as jest.Mock;
const mockGetEnrolledClasses = classroomService.getEnrolledClasses as jest.Mock;
const mockCreateClass = classroomService.createClass as jest.Mock;
const mockEnrollInClass = classroomService.enrollInClass as jest.Mock;
const mockRemoveStudent = classroomService.removeStudentFromClass as jest.Mock;

function makeClass(overrides: Partial<ClassRoom> = {}): ClassRoom {
  return {
    id: "class1",
    name: "CS 101",
    instructorId: "instructor1",
    joinCode: "ABC123",
    studentIds: ["student1", "student2"],
    schemaVersion: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAuth.mockReturnValue({ user: { uid: "instructor1" } });
});

describe("ClassroomHome", () => {
  it("shows a loading state before both lists resolve", async () => {
    let resolveTeaching: (v: ClassRoom[]) => void = () => {};
    mockGetInstructorClasses.mockReturnValue(new Promise((r) => (resolveTeaching = r)));
    mockGetEnrolledClasses.mockResolvedValue([]);

    render(<ClassroomHome />);
    expect(screen.getByTestId("classroom-home-loading")).toBeTruthy();

    resolveTeaching([]);
    await waitFor(() => expect(screen.getByTestId("classroom-home")).toBeTruthy());
  });

  it("lists the classes the user teaches and is enrolled in", async () => {
    mockGetInstructorClasses.mockResolvedValue([makeClass()]);
    mockGetEnrolledClasses.mockResolvedValue([makeClass({ id: "class2", name: "Bio 201", instructorId: "someoneElse" })]);

    render(<ClassroomHome />);

    await waitFor(() => expect(screen.getByTestId("teaching-class-class1")).toBeTruthy());
    expect(screen.getByText("CS 101")).toBeTruthy();
    expect(screen.getByTestId("enrolled-class-class2")).toBeTruthy();
    expect(screen.getByText("Bio 201")).toBeTruthy();
  });

  it("navigates to the cohort grid when a taught class is pressed", async () => {
    mockGetInstructorClasses.mockResolvedValue([makeClass()]);
    mockGetEnrolledClasses.mockResolvedValue([]);

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("teaching-class-class1")).toBeTruthy());

    fireEvent.press(screen.getByTestId("teaching-class-class1"));
    expect(mockPush).toHaveBeenCalledWith("/class/class1");
  });

  it("creates a class through classroomService.createClass, wiring I1's create flow to real UI", async () => {
    mockGetInstructorClasses.mockResolvedValue([]);
    mockGetEnrolledClasses.mockResolvedValue([]);
    mockCreateClass.mockResolvedValue({ classId: "newClass1", joinCode: "NEWCOD" });

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("classroom-home")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("create-class-input"), "  CS 202  ");
    fireEvent.press(screen.getByTestId("create-class-button"));

    await waitFor(() => expect(mockCreateClass).toHaveBeenCalledWith("CS 202"));
    await waitFor(() => expect(screen.getByTestId("created-class-code")).toBeTruthy());
    expect(screen.getByTestId("teaching-class-newClass1")).toBeTruthy();
  });

  it("does not call createClass for a blank name", async () => {
    mockGetInstructorClasses.mockResolvedValue([]);
    mockGetEnrolledClasses.mockResolvedValue([]);

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("classroom-home")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("create-class-input"), "   ");
    fireEvent.press(screen.getByTestId("create-class-button"));

    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("joins a class through classroomService.enrollInClass, wiring I1's join flow to real UI", async () => {
    mockGetInstructorClasses.mockResolvedValue([]);
    mockGetEnrolledClasses.mockResolvedValueOnce([]).mockResolvedValueOnce([makeClass({ id: "class9" })]);
    mockEnrollInClass.mockResolvedValue({ classId: "class9" });

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("classroom-home")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("join-code-input"), "abc123");
    fireEvent.press(screen.getByTestId("join-class-button"));

    await waitFor(() => expect(mockEnrollInClass).toHaveBeenCalledWith("abc123"));
    await waitFor(() => expect(screen.getByTestId("enrolled-class-class9")).toBeTruthy());
  });

  it("surfaces the join error rather than crashing on a bad code", async () => {
    mockGetInstructorClasses.mockResolvedValue([]);
    mockGetEnrolledClasses.mockResolvedValue([]);
    mockEnrollInClass.mockRejectedValue(new Error("No class found with that join code."));

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("classroom-home")).toBeTruthy());

    fireEvent.changeText(screen.getByTestId("join-code-input"), "ZZZZZZ");
    fireEvent.press(screen.getByTestId("join-class-button"));

    await waitFor(() => expect(screen.getByText(/No class found/)).toBeTruthy());
  });

  it("manages the roster: toggling reveals students, and Remove calls removeStudentFromClass", async () => {
    mockGetInstructorClasses.mockResolvedValue([makeClass()]);
    mockGetEnrolledClasses.mockResolvedValue([]);
    mockRemoveStudent.mockResolvedValue(undefined);

    render(<ClassroomHome />);
    await waitFor(() => expect(screen.getByTestId("teaching-class-class1")).toBeTruthy());

    fireEvent.press(screen.getByTestId("toggle-roster-class1"));
    expect(screen.getByTestId("remove-student-class1-student1")).toBeTruthy();

    fireEvent.press(screen.getByTestId("remove-student-class1-student1"));
    await waitFor(() => expect(mockRemoveStudent).toHaveBeenCalledWith("class1", "student1"));
    await waitFor(() => expect(screen.queryByTestId("remove-student-class1-student1")).toBeNull());
    expect(screen.getByTestId("remove-student-class1-student2")).toBeTruthy();
  });
});
