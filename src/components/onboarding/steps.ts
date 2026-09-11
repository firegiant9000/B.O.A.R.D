// Month 5 — the first-run onboarding walkthrough's step copy (ROADMAP.md item
// 4: "First-run tutorial... 90-second walkthrough", steps per the task brief:
// draw → shape → invite → schedule session → end session → see AI summary).
//
// Every step only *describes* a real affordance elsewhere in the app — it
// never performs one. Steps 3–6 name features with real costs (a session
// create is plan-gated, an AI summary spends metered quota), so this stays a
// read-only explainer rather than a shortcut that invites/schedules/ends/
// generates on the viewer's behalf.

export interface OnboardingStep {
  key: "draw" | "shape" | "invite" | "schedule" | "end" | "summary";
  /** An Ionicons glyph name (kept as a plain string — see OnboardingTutorial.tsx). */
  icon: string;
  title: string;
  body: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: "draw",
    icon: "pencil-outline",
    title: "Draw anything",
    body: "Sketch freely with the pen tool. Everyone else on the board sees your strokes appear live.",
  },
  {
    key: "shape",
    icon: "shapes-outline",
    title: "Snap to shapes",
    body: "Rough out a shape and it straightens into a clean rectangle, circle, or line automatically.",
  },
  {
    key: "invite",
    icon: "person-add-outline",
    title: "Bring your group in",
    body: "Invite classmates or teammates to the workspace so they can open this board too.",
  },
  {
    key: "schedule",
    icon: "calendar-outline",
    title: "Schedule a session",
    body: "Pick a time for a focused study session — participants get notified when it starts.",
  },
  {
    key: "end",
    icon: "checkmark-done-outline",
    title: "Wrap up the session",
    body: "End the session when you're done to lock in exactly what the board looked like.",
  },
  {
    key: "summary",
    icon: "sparkles-outline",
    title: "Get the AI summary",
    body: "Generate a recap of what was covered — key points and next steps, ready to share.",
  },
];
