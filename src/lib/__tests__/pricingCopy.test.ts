import fs from "fs";
import path from "path";
import { PLAN_LIMITS, UNLIMITED } from "../planLimits";
import { PLAN_CARDS, PENDING_PRO_PRICE_LABEL, planFeatures } from "../pricingCopy";

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

  it("phrases the collaborator cap as per-board, never per-workspace — the cap applies board by board", () => {
    for (const plan of ["free", "pro", "edu"] as const) {
      const features = planFeatures(plan).join(" | ");
      expect(features).toMatch(/collaborators? per board/i);
      expect(features).not.toMatch(/per workspace/i);
    }
  });

  it("never renders the `workspaces` limit — PLAN_LIMITS lists a number for it, but nothing enforces it (firestore.rules permits unlimited workspace creation and cannot count a user's existing ones)", () => {
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

  it("UpsellModal.native.tsx never imports pricingCopy.ts (it must carry no price — see that file's header)", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../components/UpsellModal.native.tsx"),
      "utf8"
    );
    expect(source).not.toMatch(/pricingCopy/);
  });
});
