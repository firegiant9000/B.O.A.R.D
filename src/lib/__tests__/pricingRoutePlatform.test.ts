import fs from "fs";
import path from "path";
// The EXACT function expo-router's own runtime calls to build the route
// tree — functions/build/global-state/router-store.js's `useStore` calls
// `getRoutes_1.getRoutes(context, { ...config, skipGenerated: true,
// ignoreEntryPoints: true, platform: Platform.OS, preserveRedirectAndRewrites:
// true })`. This test calls the identical function with the identical
// option shape (confirmed by reading that file — see the task report), not
// a hand-rolled substitute, so a false pass here would mean expo-router
// itself is broken, not this test.
import { getRoutes } from "expo-router/build/getRoutes";
import type { RequireContext } from "expo-router/build/types";

// This is the empirical verification the task explicitly asked for: does
// expo-router honour a platform-extension route file (`pricing.web.tsx`) in
// THIS installed version (expo-router 55.0.7), and — the property that
// actually matters for store compliance — can a native build ever resolve
// the real, price-bearing page?
//
// The answer this test proves is NOT the naive one. Probing getRoutes
// directly (see the task report) showed that a `.web.tsx` file with NO bare
// sibling throws at route-tree build time — "The file ./pricing.web.tsx
// does not have a fallback sibling file without a platform extension" — on
// the WEB build itself, not just on native. expo-router requires a
// non-platform-suffixed fallback file to exist for every platform-suffixed
// route. app/pricing.tsx is that mandatory fallback, and because expo-router
// resolves it as the ONLY candidate for iOS/Android (pricing.web.tsx is
// skipped for any platform that doesn't match "web"/"native"), that fallback
// file IS what a native build resolves for `/pricing` — so it must itself
// carry the same no-price/no-checkout invariant as
// src/components/UpsellModal.native.tsx. This test verifies BOTH halves:
// which file resolves per platform, AND that whichever one resolves for a
// native build is safe.

const APP_DIR = path.join(__dirname, "../../../app");

/** Builds a Metro-shaped `RequireContext` from the REAL files on disk under
 *  app/ — not a synthetic fixture — so this test tracks the actual route
 *  tree this app ships, the same way Metro's generated context would.
 *  `loadRoute` is never invoked by anything this test calls (see the
 *  `getRoutes` options below), so the context function itself never needs
 *  to actually load a module. */
function realAppContext() {
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
  // Same option shape router-store.js passes at runtime (see header
  // comment), aside from `config` (this app's app.json has no
  // `expo.extra.router` overrides to spread in).
  const tree = getRoutes(realAppContext(), {
    skipGenerated: true,
    ignoreEntryPoints: true,
    platform,
    preserveRedirectAndRewrites: true,
  });
  if (!tree) throw new Error("getRoutes returned no route tree for app/ — app/ is misconfigured");
  return tree.children;
}

// Matches the same "no payment content anywhere in source" invariant
// src/components/__tests__/UpsellModal.test.tsx enforces on
// UpsellModal.native.tsx — reused here against whichever file resolves for
// the `pricing` route on a native platform.
const NO_PAYMENT_CONTENT = /\$(?!\{)|https?:|stripe|checkout|price/i;

describe("the `pricing` route — platform-extension resolution, verified against this project's actual installed expo-router (not assumed)", () => {
  it("on a web build, resolves to app/pricing.web.tsx — the real, price-bearing page", () => {
    const pricing = routesForPlatform("web").find((r) => r.route === "pricing");
    expect(pricing).toBeDefined();
    expect(pricing!.contextKey).toBe("./pricing.web.tsx");
  });

  it.each(["ios", "android"] as const)(
    "on a %s build, never resolves app/pricing.web.tsx for the `pricing` route",
    (platform) => {
      const pricing = routesForPlatform(platform).find((r) => r.route === "pricing");
      // Either no `pricing` route exists at all for this platform, or (since
      // app/pricing.tsx is a mandatory fallback — see header comment) it
      // resolves to that bare file — never the `.web` one.
      if (pricing) {
        expect(pricing.contextKey).not.toMatch(/\.web\.tsx$/);
      }
    }
  );

  it.each(["ios", "android"] as const)(
    "whatever file DOES resolve for `pricing` on a %s build contains no price, checkout, or Stripe reference in its source — the property that actually matters, independent of filename",
    (platform) => {
      const pricing = routesForPlatform(platform).find((r) => r.route === "pricing");
      if (!pricing) return; // no route at all is equally compliant
      const filePath = path.join(APP_DIR, pricing.contextKey.replace(/^\.\//, ""));
      const source = fs.readFileSync(filePath, "utf8");
      expect(source).not.toMatch(NO_PAYMENT_CONTENT);
      expect(source.toLowerCase()).not.toContain("billingservice");
    }
  );

  it("app/pricing.tsx (the mandatory fallback) is a real file on disk — expo-router throws without it", () => {
    // Guards the premise the rest of this suite depends on: without this
    // file, `routesForPlatform("web")` above would throw "does not have a
    // fallback sibling file without a platform extension" instead of
    // returning a tree to inspect at all (verified in the task report).
    expect(fs.existsSync(path.join(APP_DIR, "pricing.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, "pricing.web.tsx"))).toBe(true);
  });
});
