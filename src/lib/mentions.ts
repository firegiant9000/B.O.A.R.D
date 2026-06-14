// Phase 10 (Month 3, roadmap item 9). @-mention tokens for comments.
//
// A mention persists as a STRUCTURED token inside the comment/reply body — not as
// plain "@Name" text — so it survives a display-name change and resolves back to a
// uid for notification fan-out. The on-disk form is:
//
//     @[Display Name](uid)
//
// `extractMentionUids` pulls the uids for the notification fan-out (deduped);
// `tokenizeBody` splits a body into plain-text and mention segments for styled
// rendering; `findActiveMentionQuery` / `applyMention` drive the composer's
// autocomplete. The pair round-trips: a body built by `applyMention` parses back
// to the same uids via `extractMentionUids` (asserted in the unit tests).

export interface MentionMember {
  uid: string;
  displayName: string;
}

export type BodySegment =
  | { type: "text"; text: string }
  | { type: "mention"; uid: string; displayName: string };

// One token: @[display](uid). The display group is non-greedy and forbids `]`; the
// uid group forbids `)` so adjacent tokens don't run together.
const TOKEN_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

// An in-progress mention being typed: an "@" at a word boundary followed by a run
// of non-whitespace, non-bracket chars (the query), anchored to the caret.
const ACTIVE_QUERY_RE = /(^|\s)@([^\s\]()@]*)$/;

/** Builds the on-disk token for a member. */
export function mentionToken(member: MentionMember): string {
  return `@[${member.displayName}](${member.uid})`;
}

/** Distinct uids mentioned in a body, in first-seen order. */
export function extractMentionUids(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(TOKEN_RE)) {
    const uid = m[2];
    if (uid && !seen.has(uid)) {
      seen.add(uid);
      out.push(uid);
    }
  }
  return out;
}

/**
 * Splits a body into plain-text and mention segments for rendering. Adjacent text
 * is merged into single segments so the renderer emits the minimum number of nodes.
 */
export function tokenizeBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    if (start > last) segments.push({ type: "text", text: body.slice(last, start) });
    segments.push({ type: "mention", displayName: m[1], uid: m[2] });
    last = start + m[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}

/** Plain-text rendering of a body (tokens collapse to "@Display Name"). */
export function toPlainText(body: string): string {
  return body.replace(TOKEN_RE, (_full, display) => `@${display}`);
}

/**
 * Detects an in-progress "@query" immediately before the caret. Returns the query
 * (text after "@", may be empty right after typing "@") and the index of the "@",
 * or null when the caret isn't inside a mention query. Used to decide whether to
 * show the autocomplete dropdown and what to filter members by.
 */
export function findActiveMentionQuery(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = before.match(ACTIVE_QUERY_RE);
  if (!m) return null;
  // m[1] is the boundary char (empty or whitespace); the "@" sits right after it.
  const start = (m.index ?? 0) + m[1].length;
  return { query: m[2], start };
}

/**
 * Replaces the active "@query" at the caret with a full mention token plus a
 * trailing space, returning the new body and the caret position after the space.
 * No-op (returns the input unchanged) when there is no active query.
 */
export function applyMention(
  text: string,
  caret: number,
  member: MentionMember
): { text: string; caret: number } {
  const active = findActiveMentionQuery(text, caret);
  if (!active) return { text, caret };
  const token = mentionToken(member) + " ";
  const next = text.slice(0, active.start) + token + text.slice(caret);
  return { text: next, caret: active.start + token.length };
}

/**
 * Filters workspace members by an autocomplete query (case-insensitive prefix /
 * substring on display name), excluding `excludeUid` (the author shouldn't mention
 * themselves). Capped to `limit` to keep the dropdown short on mobile.
 */
export function filterMembers(
  members: MentionMember[],
  query: string,
  excludeUid?: string,
  limit = 6
): MentionMember[] {
  const q = query.trim().toLowerCase();
  return members
    .filter((m) => m.uid !== excludeUid)
    .filter((m) => q === "" || m.displayName.toLowerCase().includes(q))
    .slice(0, limit);
}
