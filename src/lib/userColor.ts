// Per-user color (Month 4, Phase 6 — live cursors, Appendix C.1). Derived
// deterministically from the uid so every client computes the same color without
// a stored field or a workspace-join migration: a user's cursor matches their
// avatar everywhere. The palette is the five distinct avatar colors that
// BoardUserBar already shipped, so existing avatars keep their exact color.
const USER_COLORS = ["#7c3aed", "#db2777", "#059669", "#d97706", "#dc2626"];

export function userColor(uid: string): string {
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = uid.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}
