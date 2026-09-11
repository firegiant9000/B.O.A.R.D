// Standard service-boundary mocks (matches every other test that transitively
// touches billingService/Firebase — see src/services/__tests__/billingService.test.ts).
// Only the web variant (imported explicitly below) touches any of this; the
// native variant imports none of it.
jest.mock("../../config/firebase", () => ({ db: {}, auth: { currentUser: null }, functions: {} }));
jest.mock("firebase/firestore", () => require("../../test-utils/firestoreMock"));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));

// Mock only the two callable-backed functions; keep the REAL `BillingCallableError`
// class so `instanceof` checks inside UpsellModal.tsx work against the real
// identity, not a test double's.
jest.mock("../../services/billingService", () => ({
  ...jest.requireActual("../../services/billingService"),
  startCheckout: jest.fn(),
  openBillingPortal: jest.fn(),
}));

import fs from "fs";
import path from "path";
import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import type { UpsellResource } from "../upsellCopy";
import { startCheckout, openBillingPortal, BillingCallableError } from "../../services/billingService";

// The load-bearing part of this file: two SEPARATE physical modules, not one
// module switched by a runtime Platform.OS check.
//
//   - `"../UpsellModal"` (no extension) resolves the way a real consumer's
//     import resolves under this repo's Jest config: `haste.platforms` for
//     the bare "jest-expo" preset is `['android', 'ios', 'native']` with
//     `defaultPlatform: 'ios'` (react-native/jest-preset.js) — no `.ios.tsx`
//     file exists here, so the resolver falls through to `.native.tsx`,
//     which does. This is the SAME resolution a native build's bundler
//     performs — nothing in this test forces it.
//   - `"../UpsellModal.tsx"` (explicit extension) is resolved as that exact
//     literal file, bypassing platform-extension resolution entirely (Node/
//     Jest only appends candidate extensions when none is given) — this is
//     the bare file, i.e. the web body.
//
// Each variant is therefore independently importable and independently
// testable; neither is reachable only through a runtime switch.
import NativeUpsellModal from "../UpsellModal";
// `require`, not `import`: TypeScript rejects a static `import` specifier
// that names a literal `.tsx` extension (TS5097) unless
// `allowImportingTsExtensions` is on project-wide, which this repo doesn't
// set. `require` isn't statically extension-checked by tsc, and resolves
// through the exact same Jest module resolver as the `import` above, so it
// reaches the identical bare file.
const WebUpsellModal: React.ComponentType<
  React.ComponentProps<typeof NativeUpsellModal>
> = require("../UpsellModal.tsx").default;

const mockStartCheckout = startCheckout as jest.Mock;
const mockOpenBillingPortal = openBillingPortal as jest.Mock;

const RESOURCES: UpsellResource[] = ["board", "session", "aiSummary", "aiCall", "customPalette"];

// The store-compliance guard's strongest layer: read every file the native
// bundle actually pulls in, as SOURCE TEXT, rather than only rendered
// output. A price or a checkout link held in a handler and never rendered
// (e.g. a bare `Linking.openURL(PAY_URL)` nobody calls in these tests) is
// invisible to `toJSON()` and to a press-driven mock-call assertion, but not
// to this. Covers both files on the native variant's own import graph:
// UpsellModal.native.tsx itself, and upsellCopy.ts (its only non-type
// import) — upsellCopy.ts is otherwise unscanned by anything, which would
// make it exactly the "shared module quietly carries the price" hole this
// split exists to close. (upsellCopy.ts's own further imports —
// planLimits.ts, quotaService.ts — are generic, not upsell-specific, and
// carry no billing code; not scanned here.)
//
// The `$` half of the pattern excludes `$` immediately followed by `{`:
// a bare `/\$/` would also flag template-literal interpolation, and
// upsellCopy.ts's own `limitMessage` legitimately uses several
// (`` `...${plan}...${limit}...` ``) — a real price ($5, $5.99, $5/month,
// ...) still matches, since a digit or other character, never `{`, follows
// the sign in every form this app uses.
const NO_PAYMENT_CONTENT = /\$(?!\{)|https?:|stripe|checkout|price/i;

const NATIVE_BUNDLE_SOURCE_FILES: Array<[label: string, relPath: string]> = [
  ["UpsellModal.native.tsx", "../UpsellModal.native.tsx"],
  ["upsellCopy.ts", "../upsellCopy.ts"],
];

describe("UpsellModal — native-reachable source (store-compliance guard)", () => {
  it.each(NATIVE_BUNDLE_SOURCE_FILES)(
    "%s contains no price, currency, Stripe reference, or link scheme anywhere in its source — not just rendered output",
    (_label, relPath) => {
      const source = fs.readFileSync(path.join(__dirname, relPath), "utf8");
      expect(source).not.toMatch(NO_PAYMENT_CONTENT);
    }
  );

  it.each(NATIVE_BUNDLE_SOURCE_FILES)("%s imports nothing from billingService", (_label, relPath) => {
    const source = fs.readFileSync(path.join(__dirname, relPath), "utf8");
    expect(source).not.toMatch(/billingService/i);
  });
});

describe("UpsellModal.native.tsx (rendered)", () => {
  it.each(RESOURCES)(
    "renders NO price and NO link for resource=%s, however worded",
    (resource) => {
      const { toJSON } = render(
        <NativeUpsellModal visible resource={resource} onDismiss={() => {}} />
      );
      const tree = JSON.stringify(toJSON());
      expect(tree).not.toMatch(/\$\d/);
      expect(tree).not.toMatch(/https?:\/\//);
      expect(tree).not.toMatch(/upgrade/i);
      expect(tree).not.toMatch(/subscri/i);
    }
  );

  it("still explains the limit that was hit", () => {
    const { getByText } = render(
      <NativeUpsellModal visible resource="board" onDismiss={() => {}} />
    );
    expect(getByText(/5 boards/i)).toBeTruthy();
  });

  // Stronger than the text-regex checks above: a checkout/upgrade affordance
  // reworded to dodge every one of those regexes (e.g. a button that just
  // says "Continue" and silently opens a link) would still be a SECOND
  // `button`-role element next to Dismiss, so this catches it regardless of
  // wording — counts actionable affordances by accessibility role, not label.
  it("offers no interactive affordance beyond Dismiss, however a checkout action might be worded", () => {
    const { getAllByRole } = render(
      <NativeUpsellModal visible resource="board" onDismiss={() => {}} />
    );
    expect(getAllByRole("button")).toHaveLength(1);
  });

  it("calls onDismiss when the sole action is pressed", () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <NativeUpsellModal visible resource="board" onDismiss={onDismiss} />
    );
    fireEvent.press(getByTestId("upsell-native-dismiss-button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("on an unlimited (Pro) plan, shows a transient note instead of a plan-limit claim — the denial can't be a plan cap", () => {
    // Pro is UNLIMITED for every resource this modal covers, so
    // resource-exhausted on a Pro workspace can only be the AI rate
    // throttle, never the plan cap — showing "you've reached the free
    // plan's limit" here would be a false paywall for a plan already owned.
    const { getByText, queryByText } = render(
      <NativeUpsellModal visible resource="aiCall" plan="pro" onDismiss={() => {}} />
    );
    expect(getByText(/sending requests a little fast/i)).toBeTruthy();
    expect(queryByText(/plan's limit/i)).toBeNull();
  });

  it("defaults to the free plan (and so the paywall claim) when no plan is supplied", () => {
    const { getByText } = render(
      <NativeUpsellModal visible resource="board" onDismiss={() => {}} />
    );
    expect(getByText(/free plan's limit of 5 boards/i)).toBeTruthy();
  });

  // Month 5 (ROADMAP items 12 + 14) — the custom-palette Pro badge routes
  // here via `resource="customPalette"`, a value deliberately NOT in
  // planLimits.ts's mirrored LimitedResource table (see upsellCopy.ts's
  // UpsellResource header) — these pin that its special-case in
  // isPlanCapped/limitMessage renders correctly, with no price/link, same as
  // every other resource this modal covers.
  it("customPalette on free: still explains it as a Pro feature, no price or link", () => {
    const { getByText, toJSON } = render(
      <NativeUpsellModal visible resource="customPalette" plan="free" onDismiss={() => {}} />
    );
    expect(getByText(/pro feature/i)).toBeTruthy();
    const tree = JSON.stringify(toJSON());
    expect(tree).not.toMatch(/\$\d/);
    expect(tree).not.toMatch(/https?:\/\//);
  });

  it("customPalette on pro: shows the transient note, not a paywall — the plan already has it", () => {
    const { getByText, queryByText } = render(
      <NativeUpsellModal visible resource="customPalette" plan="pro" onDismiss={() => {}} />
    );
    expect(getByText(/sending requests a little fast/i)).toBeTruthy();
    expect(queryByText(/pro feature/i)).toBeNull();
  });
});

describe("UpsellModal.tsx (web, rendered)", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("shows the price and an upgrade action", () => {
    const { getByText } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} />
    );
    expect(getByText(/\$5/)).toBeTruthy();
    expect(getByText(/upgrade/i)).toBeTruthy();
  });

  it("names the limit that was hit", () => {
    const { getByText } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} />
    );
    expect(getByText(/5 boards/i)).toBeTruthy();
  });

  it("customPalette on free: shows the price + upgrade action, same as a real quota resource", () => {
    const { getByText, queryByText } = render(
      <WebUpsellModal visible resource="customPalette" plan="free" onDismiss={() => {}} />
    );
    expect(getByText(/pro feature/i)).toBeTruthy();
    expect(getByText(/\$5/)).toBeTruthy();
    expect(getByText(/upgrade/i)).toBeTruthy();
    // MAX_WORKSPACE_SWATCHES caps every plan, Pro included — "unlocks
    // unlimited custom colour swatches" would overstate that (unlockPhrase's
    // own header explains why this resource gets its own accurate phrase).
    expect(getByText(/unlocks the custom colour swatch palette/i)).toBeTruthy();
    expect(queryByText(/unlimited custom colour swatches/i)).toBeNull();
  });

  it("on an unlimited (Pro) plan, shows the transient note instead of the paywall — no price, no upgrade action", () => {
    const { getByText, queryByText, queryByTestId } = render(
      <WebUpsellModal visible resource="aiCall" plan="pro" onDismiss={() => {}} />
    );
    expect(getByText(/sending requests a little fast/i)).toBeTruthy();
    expect(queryByText(/\$5/)).toBeNull();
    expect(queryByTestId("upsell-web-upgrade-button")).toBeNull();
  });

  it("starts checkout with the given workspace and opens the returned URL", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockResolvedValueOnce("https://checkout.stripe.test/s/1");

    const { getByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(mockStartCheckout).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://checkout.stripe.test/s/1"));
    openURLSpy.mockRestore();
  });

  it("routes on details.canOpenPortal=true by offering the Customer Portal, not a message-text guess", async () => {
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("This workspace's subscription needs attention.", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );

    const { getByTestId, queryByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByTestId("upsell-web-portal-button")).toBeTruthy());
  });

  it("does NOT offer the portal when details.canOpenPortal=false, even if the message reads like it should", async () => {
    // The message deliberately mentions "portal" — if routing ever regresses
    // to sniffing `.message` text instead of `.details.canOpenPortal`, this fails.
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError(
        "Please open the billing portal to resolve this subscription.",
        "failed-precondition",
        { reason: "subscription-paused", canOpenPortal: false }
      )
    );

    const { getByTestId, queryByTestId, getByText } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));

    await waitFor(() => expect(getByText(/resolve this subscription/i)).toBeTruthy());
    expect(queryByTestId("upsell-web-portal-button")).toBeNull();
  });

  it("pressing the portal action opens the URL from openBillingPortal", async () => {
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    mockStartCheckout.mockRejectedValueOnce(
      new BillingCallableError("needs attention", "failed-precondition", {
        reason: "subscription-exists",
        canOpenPortal: true,
      })
    );
    mockOpenBillingPortal.mockResolvedValueOnce("https://billing.stripe.test/p/1");

    const { getByTestId } = render(
      <WebUpsellModal visible resource="board" onDismiss={() => {}} workspaceId="ws-1" />
    );
    fireEvent.press(getByTestId("upsell-web-upgrade-button"));
    await waitFor(() => getByTestId("upsell-web-portal-button"));
    fireEvent.press(getByTestId("upsell-web-portal-button"));

    await waitFor(() => expect(mockOpenBillingPortal).toHaveBeenCalledWith("ws-1"));
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
    openURLSpy.mockRestore();
  });
});
