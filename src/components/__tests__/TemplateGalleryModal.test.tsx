jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

// Fixture groups, independent of the real 21 template files — this test
// covers the gallery's own rendering/selection/error-handling behavior, not
// the template content (that's templates.validity.test.ts's job).
const mockCreateBoardFromTemplate = jest.fn();
const mockListTemplatesByCategory = jest.fn(() => [
  {
    category: "study",
    label: "Study",
    templates: [
      { schemaVersion: 1, id: "cornell-notes", title: "Cornell Notes", category: "study", description: "Cue/notes columns.", elements: [] },
      { schemaVersion: 1, id: "flashcard-deck", title: "Flashcard Deck", category: "study", description: "Front/back cards.", elements: [] },
    ],
  },
  {
    category: "meeting",
    label: "Meetings",
    templates: [
      { schemaVersion: 1, id: "standup", title: "Daily Standup", category: "meeting", description: "Yesterday/today/blockers.", elements: [] },
    ],
  },
]);
// jest's module-factory hoisting only allows referencing out-of-scope
// variables named `mock*` (see analyticsService.test.ts's own note on this).
jest.mock("../../services/templateService", () => ({
  listTemplatesByCategory: () => mockListTemplatesByCategory(),
  createBoardFromTemplate: (...args: unknown[]) => mockCreateBoardFromTemplate(...args),
}));

const mockLogBoardCreated = jest.fn();
jest.mock("../../services/activityService", () => ({
  logBoardCreated: (...args: unknown[]) => mockLogBoardCreated(...args),
}));

import React from "react";
import { Alert } from "react-native";
import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import TemplateGalleryModal from "../TemplateGalleryModal";
import { QuotaExceededError } from "../../services/quotaService";

/**
 * TemplateGalleryModal.test.tsx — Month 6. Proves the gallery
 * actually renders real, grouped template content and that selecting a
 * template drives the full create-from-template flow (or the two failure
 * paths) without ever touching Firestore/a callable directly — this
 * component's only collaborators are templateService and activityService.
 */

const baseProps = {
  visible: true,
  onClose: jest.fn(),
  onCreated: jest.fn(),
  onQuotaDenied: jest.fn(),
  ownerId: "user-1",
  ownerName: "Ada",
  workspaceId: "ws-1",
  plan: "free" as const,
  currentBoardCount: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
});

it("renders every template, grouped under its category label", () => {
  render(<TemplateGalleryModal {...baseProps} />);
  expect(screen.getByText("Study")).toBeTruthy();
  expect(screen.getByText("Cornell Notes")).toBeTruthy();
  expect(screen.getByText("Flashcard Deck")).toBeTruthy();
  expect(screen.getByText("Meetings")).toBeTruthy();
  expect(screen.getByText("Daily Standup")).toBeTruthy();
});

it("tapping the close button calls onClose", () => {
  render(<TemplateGalleryModal {...baseProps} />);
  fireEvent.press(screen.getByLabelText("Close template gallery"));
  expect(baseProps.onClose).toHaveBeenCalledTimes(1);
});

it("selecting a template creates the board, logs the activity event, and reports the new board id", async () => {
  mockCreateBoardFromTemplate.mockResolvedValue("board-42");
  render(<TemplateGalleryModal {...baseProps} />);

  fireEvent.press(screen.getByText("Daily Standup"));

  await waitFor(() => expect(baseProps.onCreated).toHaveBeenCalledWith("board-42"));
  expect(mockCreateBoardFromTemplate).toHaveBeenCalledWith("standup", "user-1", "ws-1", "free", 2);
  expect(mockLogBoardCreated).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    boardId: "board-42",
    actorId: "user-1",
    actorName: "Ada",
    title: "Daily Standup",
  });
  expect(baseProps.onQuotaDenied).not.toHaveBeenCalled();
});

it("routes a quota denial to onQuotaDenied instead of a generic error, and never logs activity or reports success", async () => {
  mockCreateBoardFromTemplate.mockRejectedValue(new QuotaExceededError("board", "ws-1"));
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  render(<TemplateGalleryModal {...baseProps} />);

  fireEvent.press(screen.getByText("Cornell Notes"));

  await waitFor(() => expect(baseProps.onQuotaDenied).toHaveBeenCalledTimes(1));
  expect(baseProps.onCreated).not.toHaveBeenCalled();
  expect(mockLogBoardCreated).not.toHaveBeenCalled();
  expect(alertSpy).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});

it("shows a generic error for a non-quota failure, without treating it as a quota denial", async () => {
  mockCreateBoardFromTemplate.mockRejectedValue(new Error("network unreachable"));
  const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  render(<TemplateGalleryModal {...baseProps} />);

  fireEvent.press(screen.getByText("Flashcard Deck"));

  await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Couldn't create board", "network unreachable"));
  expect(baseProps.onQuotaDenied).not.toHaveBeenCalled();
  expect(baseProps.onCreated).not.toHaveBeenCalled();
  expect(mockLogBoardCreated).not.toHaveBeenCalled();
  alertSpy.mockRestore();
});
