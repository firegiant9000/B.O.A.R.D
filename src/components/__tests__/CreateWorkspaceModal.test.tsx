jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

// CreateWorkspaceModal imports `isQuotaDenial` from quotaService, which pulls
// in planLimits and (transitively) nothing Firestore-backed — but the same
// config/firebase + firestore mocks every service-consuming component test
// uses are kept here so the module graph never depends on a real config.
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import CreateWorkspaceModal from "../CreateWorkspaceModal";
import { QuotaExceededError } from "../../services/quotaService";

/**
 * CreateWorkspaceModal — the workspace cap's denial path.
 *
 * The workspace cap is one of the five enforced plan gates and was the only
 * one whose denial never reached `UpsellModal`: this modal rendered
 * `createWorkspace`'s raw rejection string ("You've reached your plan's
 * workspace limit (1). Upgrade for more.") inline, so it also never got
 * `upsellCadence`'s soft-first/hard-second treatment. What is pinned below is
 * the routing decision — a quota denial leaves this component entirely, and
 * anything else still surfaces here.
 */

/** The shape a callable rejection actually arrives in: a `code` of
 *  `functions/resource-exhausted` and a human message. Built here rather than
 *  imported because that is the wire shape, and a test that constructed it
 *  through a helper would stop proving the component recognises the real one. */
function resourceExhausted(message: string) {
  return Object.assign(new Error(message), { code: "functions/resource-exhausted" });
}

function renderModal(over: Partial<React.ComponentProps<typeof CreateWorkspaceModal>> = {}) {
  const props = {
    visible: true,
    onClose: jest.fn(),
    onCreate: jest.fn(async () => "ws-1"),
    onCreated: jest.fn(),
    onQuotaDenied: jest.fn(),
    ...over,
  };
  render(<CreateWorkspaceModal {...props} />);
  return props;
}

async function submit(name = "CS 301") {
  fireEvent.changeText(screen.getByPlaceholderText("e.g. CS 301 Study Group"), name);
  // `handleSubmit` is async and settles its state after the press returns, so
  // the press is flushed inside `act` rather than left to a later tick.
  await act(async () => {
    fireEvent.press(screen.getByText("Create"));
  });
}

describe("CreateWorkspaceModal — over-cap routing", () => {
  it("routes a resource-exhausted rejection to onQuotaDenied instead of rendering it", async () => {
    const props = renderModal({
      onCreate: jest.fn(async () => {
        throw resourceExhausted("You've reached your plan's workspace limit (1). Upgrade for more.");
      }),
    });

    await submit();

    await waitFor(() => expect(props.onQuotaDenied).toHaveBeenCalledTimes(1));
    // The raw callable string must not also appear inline — the whole point is
    // that the user sees the cadence-aware modal, not a sentence ending in
    // "Upgrade for more." with nothing to upgrade with.
    expect(screen.queryByText(/workspace limit/i)).toBeNull();
    expect(screen.queryByText(/Upgrade for more/i)).toBeNull();
  });

  it("routes a QuotaExceededError the same way (it carries no code) — defence in depth, not a live path", async () => {
    // Deliberately a "board" error in a workspace modal, and that mismatch is
    // the honest part: `quotaService.ts` states that there is NO
    // `QuotaResource` entry for workspaces, so no pre-flight can throw a
    // workspace one and this exact object cannot arise here. What is pinned is
    // that the component branches on `isQuotaDenial` — the function every
    // create site is supposed to call — rather than on the narrower
    // `isResourceExhausted`, so it needs no revisiting if workspaces ever do
    // get a pre-flight. See `CreateWorkspaceModal.tsx`'s own note.
    const props = renderModal({
      onCreate: jest.fn(async () => {
        throw new QuotaExceededError("board", "ws-1");
      }),
    });

    await submit();

    await waitFor(() => expect(props.onQuotaDenied).toHaveBeenCalledTimes(1));
  });

  it("still shows any OTHER failure inline, and does not reach for the upsell", async () => {
    // The positive control. Without it, a component that called
    // `onQuotaDenied` for every rejection would pass both tests above while
    // silently swallowing offline errors and permission failures.
    const props = renderModal({
      onCreate: jest.fn(async () => {
        throw new Error("Network request failed.");
      }),
    });

    await submit();

    await waitFor(() => expect(screen.getByText("Network request failed.")).toBeTruthy());
    expect(props.onQuotaDenied).not.toHaveBeenCalled();
  });

  it("still reports a successful create to onCreated", async () => {
    // The other positive control: the denial branch must not be on the success
    // path. A component that treated every outcome as a denial would satisfy
    // the first two tests.
    const props = renderModal();

    await submit();

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith("ws-1"));
    expect(props.onQuotaDenied).not.toHaveBeenCalled();
  });
});
