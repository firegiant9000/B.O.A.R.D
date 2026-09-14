import fs from "fs";
import path from "path";
import { PLAN_LIMITS, UNLIMITED } from "../planLimits";
import {
  PLAN_CARDS,
  PENDING_PRO_PRICE_LABEL,
  PRICE_PROVISIONAL_NOTE,
  BILLING_LIVE,
  planFeatures,
  canCheckoutNow,
  checkoutCtaLabel,
} from "../pricingCopy";

// Files that must never import this module at all — each carries the same
// store-compliance invariant as UpsellModal.native.tsx (no price, no
// checkout affordance, reachable from a native build). Single-file source
// scans, not an import-graph walk: a price reaching a native-reachable file
// THROUGH one of these would be caught by nothing else, which is exactly
// why upsellCopy.ts is listed even though PricingBody.native.tsx doesn't
// import it either — the guard is what keeps both facts true.
// WIDENED for the soft/hard upsell cadence (ROADMAP.md:608 item 14): the two
// modules that decide which body the upsell shows are reached from
// app/board/[id].tsx, which renders on native, so they carry the same
// invariant as the three already here. Belt and braces with the
// NO_PAYMENT_CONTENT scan in UpsellModal.test.tsx — that pattern includes
// /price/i and so already rejects the literal string "pricingCopy" — kept
// anyway because the two existing upsell entries are redundant with it in
// exactly the same way, and because THIS file is the one someone editing
// pricingCopy.ts will have open. Strictly additive: no entry was removed and
// the assertion is unchanged.
const MUST_NEVER_IMPORT_PRICING_COPY: Array<[label: string, relPath: string]> = [
  ["UpsellModal.native.tsx", "../../components/UpsellModal.native.tsx"],
  ["upsellCopy.ts", "../../components/upsellCopy.ts"],
  ["PricingBody.native.tsx", "../../components/PricingBody.native.tsx"],
  ["services/upsellCadence.ts", "../../services/upsellCadence.ts"],
  ["hooks/useUpsellCadence.ts", "../../hooks/useUpsellCadence.ts"],
];

describe("planFeatures — driven by PLAN_LIMITS, never retyped", () => {
  it("renders the free tier's boards and sessions limits verbatim from PLAN_LIMITS", () => {
    const features = planFeatures("free");
    expect(features.join(" | ")).toMatch(new RegExp(`${PLAN_LIMITS.free.boards} boards`, "i"));
    expect(features.join(" | ")).toMatch(
      new RegExp(`${PLAN_LIMITS.free.sessionsPerPeriod} sessions`, "i")
    );
  });

  // The load-bearing test: reads PLAN_LIMITS through planFeatures() rather
  // than a copy someone retyped. Mutating the SAME object planFeatures
  // reads and asserting the output tracks the mutation is the only way to
  // prove that — a hardcoded `"5 boards"` string would still pass a test
  // that merely checks the CURRENT PLAN_LIMITS values, but would fail this
  // one, because the output would not move with the table.
  it("tracks PLAN_LIMITS when it changes, proving the numbers are read, not retyped", () => {
    const original = { ...PLAN_LIMITS.free };
    try {
      PLAN_LIMITS.free.boards = 999;
      PLAN_LIMITS.free.sessionsPerPeriod = 777;
      PLAN_LIMITS.free.aiCallsPerPeriod = 555;
      PLAN_LIMITS.free.collaboratorsPerBoard = 333;

      const features = planFeatures("free").join(" | ");
      expect(features).toMatch(/999 boards/);
      expect(features).toMatch(/777 sessions per month/);
      expect(features).toMatch(/555 AI calls per month/);
      expect(features).toMatch(/333 collaborators per board/);
    } finally {
      Object.assign(PLAN_LIMITS.free, original);
    }
  });

  it("renders the UNLIMITED sentinel (Infinity) as the word Unlimited, never as a number", () => {
    const proFeatures = planFeatures("pro").join(" | ");
    expect(PLAN_LIMITS.pro.boards).toBe(UNLIMITED);
    expect(proFeatures).toMatch(/Unlimited boards/);
    expect(proFeatures).toMatch(/Unlimited sessions per month/);
    expect(proFeatures).toMatch(/Unlimited AI calls per month/);
    expect(proFeatures).not.toMatch(/Infinity/i);
  });

  // The defect this pins: `aiCallsPerPeriod` is UNLIMITED on Pro, so the card
  // read "Unlimited AI calls per month" while `boardQaPerPeriod` was 200 and
  // enforced server-side (functions/src/ai/usage.ts#checkFeatureQuota). A Pro
  // customer asking a 201st board question was denied a feature the pricing
  // page had called unlimited. `upsellCopy.ts` had already identified exactly
  // this hazard — "`boardQaPerPeriod` is FINITE on every plan, so 'unlimited'
  // would be a false claim about what upgrading buys" — and acted on it; this
  // is the pricing page catching up.
  it("never leaves the AI-calls line claiming an unqualified 'unlimited' while board Q&A carries a finite sub-cap", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      expect(PLAN_LIMITS[plan].boardQaPerPeriod).not.toBe(UNLIMITED);
      const aiLine = planFeatures(plan).find((f) => /AI calls? per month/.test(f));
      expect(aiLine).toBeDefined();
      expect(aiLine).toMatch(
        new RegExp(`board Q&A[^0-9]*${PLAN_LIMITS[plan].boardQaPerPeriod}`, "i")
      );
    }
  });

  // Same load-bearing property as the drift test above, applied to the
  // qualifier: mutate the SAME object planFeatures reads and assert the
  // sub-cap figure moves with it, so this can never become a retyped "200".
  it("reads the board Q&A sub-cap from PLAN_LIMITS rather than retyping it", () => {
    const original = { ...PLAN_LIMITS.pro };
    try {
      PLAN_LIMITS.pro.boardQaPerPeriod = 1234;
      expect(planFeatures("pro").join(" | ")).toMatch(/board Q&A[^0-9]*1234/i);
    } finally {
      Object.assign(PLAN_LIMITS.pro, original);
    }
  });

  it("phrases the collaborator cap as per-board, never per-workspace — the cap applies board by board", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      const features = planFeatures(plan).join(" | ");
      expect(features).toMatch(/collaborators? per board/i);
      expect(features).not.toMatch(/per workspace/i);
    }
  });

  // The `workspaces` cap IS enforced (the createWorkspace callable counts the
  // caller's owned workspaces; firestore.rules denies client creates and pins
  // `ownerId`). It is omitted from this list for a scope reason, not an
  // enforcement one: every other line on a pricing card is a per-workspace
  // entitlement and this one is per-OWNER — see pricingCopy.ts's own comment.
  // This pins the omission, not a claim about whether the cap exists.
  it("never renders the `workspaces` limit, whose cap is per-owner rather than per-workspace", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      expect(planFeatures(plan).join(" | ")).not.toMatch(/workspace/i);
    }
  });
});

describe("PLAN_CARDS", () => {
  it("lists Free before Pro before Edu", () => {
    expect(PLAN_CARDS.map((c) => c.id)).toEqual(["free", "pro", "edu"]);
  });

  it("only the Pro card carries a checkout action — Free is already the default plan, Edu is granted out of band, never self-serve", () => {
    expect(PLAN_CARDS.find((c) => c.id === "free")?.ctaLabel).toBeUndefined();
    expect(PLAN_CARDS.find((c) => c.id === "pro")?.ctaLabel).toBe("Upgrade to Pro");
    expect(PLAN_CARDS.find((c) => c.id === "edu")?.ctaLabel).toBeUndefined();
  });

  it("the Pro card's displayed price IS the shared placeholder constant, not a second copy of it", () => {
    expect(PLAN_CARDS.find((c) => c.id === "pro")?.priceLabel).toBe(PENDING_PRO_PRICE_LABEL);
  });

  it("every card's features come from planFeatures(id), not a separately hand-written list", () => {
    for (const card of PLAN_CARDS) {
      expect(card.features).toEqual(planFeatures(card.id));
    }
  });
});

describe("PENDING_PRO_PRICE_LABEL — the single source of truth for the placeholder price", () => {
  it("is a non-empty placeholder string (Gate G4 is unmet; this is not a business decision)", () => {
    expect(typeof PENDING_PRO_PRICE_LABEL).toBe("string");
    expect(PENDING_PRO_PRICE_LABEL.length).toBeGreaterThan(0);
  });

  it("UpsellModal.tsx (web) imports this constant instead of declaring its own copy of it", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../components/UpsellModal.tsx"),
      "utf8"
    );
    expect(source).toMatch(/PENDING_PRO_PRICE_LABEL/);
    expect(source).toMatch(/from\s+["']\.\.\/lib\/pricingCopy["']/);
    // The regression this guards against: a second, independently-declared
    // placeholder that could silently drift from this one.
    expect(source).not.toMatch(/const\s+PENDING_PRO_PRICE_LABEL\s*=/);
  });

  it.each(MUST_NEVER_IMPORT_PRICING_COPY)(
    "%s never imports pricingCopy.ts (it must carry no price — see that file's header)",
    (_label, relPath) => {
      const source = fs.readFileSync(path.join(__dirname, relPath), "utf8");
      expect(source).not.toMatch(/pricingCopy/);
    }
  );
});

describe("BILLING_LIVE and PRICE_PROVISIONAL_NOTE — no button may present as a working purchase while G3/G4 are unmet", () => {
  it("BILLING_LIVE is false — there is no live Stripe account behind this app yet", () => {
    // Not `expect(...).toBeFalsy()`: a `false` boolean is the ONLY value
    // that renders "false" as gating-code intent — this must be a real
    // gate, not an undefined/empty-string stand-in that a strict `!==
    // false` check elsewhere would treat as truthy.
    expect(BILLING_LIVE).toBe(false);
  });

  it("the Pro card carries a user-visible provisional-pricing note; Free and Edu (non-numeric prices) do not", () => {
    expect(PLAN_CARDS.find((c) => c.id === "pro")?.priceNote).toBe(PRICE_PROVISIONAL_NOTE);
    expect(PLAN_CARDS.find((c) => c.id === "free")?.priceNote).toBeUndefined();
    expect(PLAN_CARDS.find((c) => c.id === "edu")?.priceNote).toBeUndefined();
  });

  it("the provisional note actually says the price isn't final, not just something non-empty", () => {
    expect(PRICE_PROVISIONAL_NOTE).toMatch(/provisional|not final|subject to change/i);
  });
});

describe("canCheckoutNow / checkoutCtaLabel — the CTA gate, unit-tested independently of any rendering or of today's real BILLING_LIVE value", () => {
  it("never permits checkout while billing isn't live, with or without a workspace", () => {
    expect(canCheckoutNow(false, true)).toBe(false);
    expect(canCheckoutNow(false, false)).toBe(false);
  });

  it("permits checkout only once billing is live AND a workspace is active", () => {
    expect(canCheckoutNow(true, false)).toBe(false);
    expect(canCheckoutNow(true, true)).toBe(true);
  });

  it("labels the button honestly for each of the three reachable states, never claiming it works when canCheckoutNow says it can't", () => {
    expect(checkoutCtaLabel(false, true)).toMatch(/not.*available|isn't available/i);
    expect(checkoutCtaLabel(false, false)).toMatch(/not.*available|isn't available/i);
    expect(checkoutCtaLabel(true, false)).toMatch(/sign in|workspace/i);
    expect(checkoutCtaLabel(true, true)).toBe("Upgrade to Pro");
  });

  it("every label EXCEPT the one for the fully-permitted state differs from the real 'Upgrade to Pro' action text", () => {
    // Guards against a future edit accidentally making the "not live" or
    // "no workspace" label collide with the live, working button's own
    // text — which would make the two indistinguishable to a user.
    expect(checkoutCtaLabel(false, true)).not.toBe("Upgrade to Pro");
    expect(checkoutCtaLabel(false, false)).not.toBe("Upgrade to Pro");
    expect(checkoutCtaLabel(true, false)).not.toBe("Upgrade to Pro");
  });

  it("today's real BILLING_LIVE denies checkout regardless of workspace state, and the button says so", () => {
    expect(canCheckoutNow(BILLING_LIVE, true)).toBe(false);
    expect(checkoutCtaLabel(BILLING_LIVE, true)).toBe("Checkout isn't available yet");
  });
});
