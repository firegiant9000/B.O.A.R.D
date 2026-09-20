import { EDIT_ACTIONS_ENABLED } from "../editActionsGate";

/**
 * A trivial-looking assertion guarding something not trivial: this flag being
 * silently flipped to `true` would wire board writes through an embed session
 * that has no revocation path (see the module's own doc comment). This test
 * exists so that flip shows up as a failing, named test rather than only as a
 * diff someone has to notice in review.
 */
describe("EDIT_ACTIONS_ENABLED", () => {
  it("is off", () => {
    expect(EDIT_ACTIONS_ENABLED).toBe(false);
  });
});
