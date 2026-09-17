// A real, round-tripping in-memory AsyncStorage fake — the cadence under test
// is the REAL `upsellCadence` service reading and writing real keys, because
// "first contact is soft, second is hard" is only worth pinning end to end.
let mockStore: Record<string, string> = {};

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn((k: string) => Promise.resolve(k in mockStore ? mockStore[k] : null)),
  setItem: jest.fn((k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  }),
  removeItem: jest.fn((k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  }),
}));

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null } }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));

jest.mock("../../services/analyticsService", () => ({ track: jest.fn() }));

const mockCreateWorkspace = jest.fn(async (_name: string, _uid: string) => "ws-new");
jest.mock("../../services/workspaceService", () => ({
  createWorkspace: (name: string, uid: string) => mockCreateWorkspace(name, uid),
  getWorkspaceRole: (ws: { members: Record<string, string> }, uid: string) => ws.members[uid],
  canManageMembers: (role: string) => role === "owner" || role === "admin",
}));

const mockUser: { uid: string } | null = { uid: "student-a" };
jest.mock("../../hooks/useAuth", () => ({ useAuth: () => ({ user: mockUser }) }));

let mockWorkspaceState: {
  workspaces: unknown[];
  activeWorkspace: unknown;
};
jest.mock("../../hooks/useWorkspace", () => ({
  useWorkspace: () => ({
    workspaces: mockWorkspaceState.workspaces,
    activeWorkspace: mockWorkspaceState.activeWorkspace,
    setActiveWorkspace: jest.fn(),
    refreshWorkspaces: jest.fn(async () => {}),
  }),
}));

jest.mock("../InviteMemberModal", () => ({ __esModule: true, default: () => null }));

// The load-bearing mock. `UpsellModal` renders nothing here; what matters is
// the PROPS it is handed, and specifically that `variant` is wired at all —
// the whole point of routing this gate through `useUpsellCadence`. A rendered
// assertion could not do this job: jest resolves the NATIVE modal file, which
// renders no price under any variant by design (its store-compliance
// invariant), so soft and hard are indistinguishable from its output.
const upsellProps: Record<string, unknown>[] = [];
jest.mock("../UpsellModal", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    upsellProps.push(props);
    return null;
  },
}));

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import WorkspaceSwitcher from "../WorkspaceSwitcher";
import type { Plan, Workspace } from "../../types";

/**
 * WorkspaceSwitcher — the workspace cap's upsell.
 *
 * This component had no test at all, which meant B3's actual deliverable was
 * unpinned: `CreateWorkspaceModal.test.tsx` covers the modal's routing
 * decision (a denial leaves the component) and stops there, so nothing
 * asserted that the denial then reaches `UpsellModal`, that `variant` is
 * supplied, or that a user's first contact with this gate is the restrained
 * notice. An edit dropping `variant={upsell.variant}` was caught by nothing.
 *
 * It also pins which workspace's plan and id are handed to the modal, which is
 * NOT the active one — see `WorkspaceSwitcher.tsx`'s own comment on why the
 * server resolves this cap over OWNED workspaces.
 */

const UID = "student-a";

function ws(over: Partial<Workspace> & { id: string; ownerId: string; plan: Plan }): Workspace {
  return {
    name: `Workspace ${over.id}`,
    members: { [over.ownerId]: "owner" },
    createdAt: new Date(2024, 0, 1),
    ...over,
  } as Workspace;
}

/** The wire shape a callable rejection actually arrives in. */
function resourceExhausted(message: string) {
  return Object.assign(new Error(message), { code: "functions/resource-exhausted" });
}

/** Open the dropdown, press "Create workspace", type a name, press Create. */
async function attemptCreate(name = "CS 301") {
  fireEvent.press(screen.getByText(mockWorkspaceState.activeWorkspace ? activeName() : "Boards"));
  fireEvent.press(screen.getByText("Create workspace"));
  fireEvent.changeText(screen.getByPlaceholderText("e.g. CS 301 Study Group"), name);
  await act(async () => {
    fireEvent.press(screen.getByText("Create"));
  });
}

function activeName(): string {
  return (mockWorkspaceState.activeWorkspace as Workspace).name;
}

/** The single set of props the upsell was last rendered with. */
function lastUpsell(): Record<string, unknown> {
  if (upsellProps.length === 0) throw new Error("UpsellModal was never rendered");
  return upsellProps[upsellProps.length - 1];
}

beforeEach(() => {
  mockStore = {};
  upsellProps.length = 0;
  jest.clearAllMocks();
  mockCreateWorkspace.mockImplementation(async () => "ws-new");
  const owned = ws({ id: "own-free", ownerId: UID, plan: "free", name: "My Workspace" });
  mockWorkspaceState = { workspaces: [owned], activeWorkspace: owned };
});

describe("WorkspaceSwitcher — the workspace cap reaches the upsell, through the cadence", () => {
  it("shows the upsell for the workspace resource when the create is denied", async () => {
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("You've reached your plan's workspace limit (1). Upgrade for more.");
    });
    render(<WorkspaceSwitcher />);

    await attemptCreate();

    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().resource).toBe("workspace");
    expect(lastUpsell().visible).toBe(true);
  });

  it("supplies a variant, and it is the restrained one on first contact", async () => {
    // B3's actual deliverable. Without `variant={upsell.variant}` this prop is
    // absent and `UpsellModal`'s own `"hard"` default takes over — a user's
    // very first encounter with the cap gets the full sell, which is exactly
    // what ROADMAP.md:608 (item 14) asks this gate not to do.
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("over cap");
    });
    render(<WorkspaceSwitcher />);

    await attemptCreate();

    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().variant).toBe("soft");
  });

  it("escalates to the hard push on the user's second encounter with the same gate", async () => {
    // The other half, and the reason the storage fake above round-trips: the
    // count has to survive the first denial for the second to read differently.
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("over cap");
    });
    const first = render(<WorkspaceSwitcher />);
    await attemptCreate();
    await waitFor(() => expect(lastUpsell().variant).toBe("soft"));
    first.unmount();

    upsellProps.length = 0;
    render(<WorkspaceSwitcher />);
    await attemptCreate();
    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().variant).toBe("hard");
  });

  it("renders no upsell at all until a denial happens", async () => {
    // The positive control. Without it, a component that rendered the modal
    // unconditionally would satisfy every assertion above.
    render(<WorkspaceSwitcher />);
    await attemptCreate();
    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(upsellProps).toHaveLength(0);
  });
});

describe("WorkspaceSwitcher — the upsell gets the OWNED workspace's plan and id, not the active one", () => {
  it("says 'free' for a member of someone else's Pro workspace who owns one free workspace", async () => {
    // The live failure this replaces: `plan={activeWorkspace?.plan}` handed
    // "pro" to `isPlanCapped`, which answered false, and the user was shown the
    // TRANSIENT-THROTTLE copy for a permanent cap — no limit named, no upgrade
    // path — after a denial the server had just made over their OWN free
    // workspace.
    const ownFree = ws({ id: "own-free", ownerId: UID, plan: "free", name: "Mine" });
    const theirPro = ws({ id: "their-pro", ownerId: "someone-else", plan: "pro", name: "Theirs" });
    theirPro.members = { "someone-else": "owner", [UID]: "member" };
    mockWorkspaceState = { workspaces: [ownFree, theirPro], activeWorkspace: theirPro };
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("over cap");
    });
    render(<WorkspaceSwitcher />);

    await attemptCreate();

    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().plan).toBe("free");
  });

  it("points checkout at a workspace the user owns, never at the active one they do not", async () => {
    // The second live failure: `workspaceId={activeWorkspace?.id}` aimed
    // checkout at a workspace the user has no authority to upgrade.
    const ownFree = ws({ id: "own-free", ownerId: UID, plan: "free", name: "Mine" });
    const theirFree = ws({ id: "their-free", ownerId: "someone-else", plan: "free", name: "Theirs" });
    theirFree.members = { "someone-else": "owner", [UID]: "member" };
    mockWorkspaceState = { workspaces: [ownFree, theirFree], activeWorkspace: theirFree };
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("over cap");
    });
    render(<WorkspaceSwitcher />);

    await attemptCreate();

    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().workspaceId).toBe("own-free");
    expect(lastUpsell().plan).toBe("free");
  });

  it("resolves the best owned plan, mirroring the server's own resolveOwnerPlan ordering", async () => {
    // Not reachable as a denial today — `workspaces` is UNLIMITED on pro, so
    // the server would not have denied this user at all — but the derivation
    // has to match the server's or the two can disagree the moment that row
    // becomes finite on a paid tier. Driven through the component rather than
    // asserted on a helper so it is the WIRING that is pinned.
    const ownFree = ws({ id: "own-free", ownerId: UID, plan: "free", name: "Mine" });
    const ownPro = ws({ id: "own-pro", ownerId: UID, plan: "pro", name: "Mine Pro" });
    mockWorkspaceState = { workspaces: [ownFree, ownPro], activeWorkspace: ownFree };
    mockCreateWorkspace.mockImplementation(async () => {
      throw resourceExhausted("over cap");
    });
    render(<WorkspaceSwitcher />);

    await attemptCreate();

    await waitFor(() => expect(upsellProps.length).toBeGreaterThan(0));
    expect(lastUpsell().plan).toBe("pro");
  });
});
