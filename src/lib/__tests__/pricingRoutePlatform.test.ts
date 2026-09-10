import fs from "fs";
import path from "path";
// The EXACT function expo-router's own runtime calls to build the route
// tree — expo-router/build/global-state/router-store.js's `useStore` calls
// `getRoutes_1.getRoutes(context, { ...config, skipGenerated: true,
// ignoreEntryPoints: true, platform: Platform.OS, preserveRedirectAndRewrites:
// true })`. This test calls the identical function with the identical
// option shape, not a hand-rolled substitute.
import { getRoutes } from "expo-router/build/getRoutes";
import type { RequireContext } from "expo-router/build/types";

// PRIOR LAYOUT (superseded — kept here as institutional memory, not
// current behavior): this suite used to prove that `pricing.web.tsx`
// resolved only on a web platform and `pricing.tsx` only on native,
// relying on expo-router's per-platform ROUTE resolution. Review caught
// that this was the wrong layer to split on: expo-router discovers routes
// via a Metro `require.context` that is NOT platform-filtered (its
// generated context module — expo-router/_ctx.ios.js — matches
// `pricing.web.tsx` on an iOS build too, and Metro's context-file matching
// takes no `platform` parameter), so a `.web.tsx` ROUTE file is bundled
// into a native build as dead-but-present code even though expo-router
// never navigates to it there. "Unreachable" is not "absent" — the plan's
// compliance property is about the binary's contents.
//
// CURRENT LAYOUT: a single, platform-agnostic route, `app/pricing.tsx`,
// which renders an IMPORTED component (`src/components/PricingBody.tsx` /
// `PricingBody.native.tsx`) — Metro's real per-platform MODULE resolution
// (not expo-router's route discovery) is what genuinely excludes the web
// body from a native bundle, the same mechanism
// src/components/UpsellModal.tsx / UpsellModal.native.tsx already relies
// on (see src/components/__tests__/UpsellModal.test.tsx and
// PricingBody.test.tsx for that proof). This file now verifies the
// route-tree half of that claim: there is exactly one route file for
// `pricing`, it has no platform extension, and it resolves identically on
// every platform — i.e., the vulnerable layout has not crept back in.

const APP_DIR = path.join(__dirname, "../../../app");

/** Builds a Metro-shaped `RequireContext` from the REAL files on disk under
 *  app/ — not a synthetic fixture — so this test tracks the actual route
 *  tree this app ships. `loadRoute` is never invoked by anything this test
 *  calls, so the context function itself never needs to actually load a
 *  module. */
function realAppContext(): RequireContext {
  const keys: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (/\.[tj]sx?$/.test(entry.name)) {
        keys.push(`./${prefix}${entry.name}`);
      }
    }
  };
  walk(APP_DIR, "");
  const contextModule = ((_key: string) => ({ default: () => null })) as unknown as RequireContext;
  contextModule.keys = () => keys;
  contextModule.resolve = (key: string) => key;
  contextModule.id = "realAppContext";
  return contextModule;
}

function routesForPlatform(platform: "web" | "ios" | "android") {
  const tree = getRoutes(realAppContext(), {
    skipGenerated: true,
    ignoreEntryPoints: true,
    platform,
    preserveRedirectAndRewrites: true,
  });
  if (!tree) throw new Error("getRoutes returned no route tree for app/ — app/ is misconfigured");
  return tree.children;
}

describe("the `pricing` route — a single, platform-agnostic route file (not split by a `.web` route extension)", () => {
  it("app/pricing.web.tsx does not exist — the layout review found unsafe", () => {
    expect(fs.existsSync(path.join(APP_DIR, "pricing.web.tsx"))).toBe(false);
  });

  it("app/pricing.tsx exists and carries no platform extension", () => {
    expect(fs.existsSync(path.join(APP_DIR, "pricing.tsx"))).toBe(true);
  });

  it.each(["web", "ios", "android"] as const)(
    "resolves the `pricing` route to app/pricing.tsx on a %s build — the SAME file on every platform",
    (platform) => {
      const pricing = routesForPlatform(platform).find((r) => r.route === "pricing");
      expect(pricing).toBeDefined();
      expect(pricing!.contextKey).toBe("./pricing.tsx");
    }
  );

  it("app/pricing.tsx itself contains no price, checkout, or Stripe reference — the platform split lives one layer down, in the component it renders", () => {
    const source = fs.readFileSync(path.join(APP_DIR, "pricing.tsx"), "utf8");
    expect(source).not.toMatch(/\$(?!\{)|https?:|stripe|checkout|price/i);
  });
});
