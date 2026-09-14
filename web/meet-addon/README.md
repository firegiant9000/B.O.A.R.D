# Google Meet add-on shell (Month 5 — ROADMAP.md item 6)

This directory is a **shell**, not a submitted or fully-wired integration. It is
the thin iframe wrapper ROADMAP.md item 6 asks for around the embed route that
already exists (`app/embed/b/[id].tsx`). Read this file before enabling
anything here for a real Meet call — several things below are deliberately
unfinished or unverified, and the section marked **BLOCKER** is a release
gate, not a suggestion.

## What exists here

- `manifest.json` — a Meet add-on manifest (`addOns.meet.web.sidePanelUrl` /
  `addOnOrigins`, `addOns.common.name` / `logoUrl`) following the schema at
  <https://developers.google.com/workspace/meet/add-ons/guides/deploy-add-on>.
- `panel.html` — the side panel itself: reads `boardId` and `token` from its
  own URL query string and iframes `https://<domain>/embed/b/{boardId}?token=
  {token}`, i.e. exactly the embed route Month 4/5 hardened. Falls back to a
  visible "not configured" message if either is missing, rather than a blank
  panel.

## What Month 5 changed in the app (not just here)

The embed route (`app/embed/b/[id].tsx`) now reads the **scope the token
exchange itself returned** (previously discarded) and, through a small pure
helper (`src/lib/embedScope.ts`, unit-tested), decides whether to render the
board with editing enabled. `app/board/[id].tsx` threads that through as
`embedCanEdit`: the toolbar and pen options show for an edit-scope embed
exactly as they do for a real editor, minus the image-insert and manual-Save
**buttons** (`Toolbar`'s `canInsertImage` / `canManualSave` props) — both
would only ever produce a write `firestore.rules` refuses (images/audio are
Storage-gated; the board document stays closed to every embed identity).
Canvas content (paths/notes/shapes/text) already attributes correctly with no
further change: writes stamp `userId` from the signed-in embed uid the same
as any other write path. `src/hooks/useBoardCollab.ts` now also lets an
edit-scope embed publish its **own cursor** (`embedEditable`), so a second
editor is visible while they draw — `CursorLayer` was never `embedMode`-gated,
so this was the one missing half. Presence (the avatar bar) and presenter/
follow mode stay off for every embed regardless of scope: nothing renders
them, since `BoardHeader` is always hidden in embed mode.

**Hiding the image button is a partial mitigation, not a closed door.**
`useBoardElements`'s Cmd/Ctrl+V image paste (a DOM `paste` listener on web,
`shortcutPaste` on native) has no role gate at all today, for anyone — a real
read-only viewer can already trigger it and hit the same
upload-then-denied-write outcome. This is a pre-existing gap, not specific to
embeds; fixing it means touching that hook's core write paths for
every role, which is out of scope here. Naming it so the button fix above is
not read as "images can't reach an embed session" — they can, through this
pre-existing path, for exactly the same reason a real viewer can today.

None of that required a URL scope parameter on the embed route itself — the
scope comes from the signed token, verified server-side by the exchange, not
from anything caller-controlled in the URL. `parseEmbedScope` defaults
anything other than the literal `"edit"` to `"view"`, on purpose: an unknown
or malformed value must never be treated as more permissive than the token
actually granted.

## What this shell does NOT do

- **It does not mint tokens.** `panel.html` has no B.O.A.R.D-authenticated
  session and never will inside a static page — minting an edit token
  requires a signed-in board owner/admin (`mintEmbedToken` in
  `functions/src/callable/mintEmbedToken.ts`) plus a host-asserted `sub`/`iss`
  pair. Nothing in this repo today produces a `?boardId=&token=` URL for this
  panel to consume per meeting. Wiring that — who mints, when, and how the
  add-on receives it for a specific Meet call — is unbuilt, unscoped work,
  not an oversight in this file.
- **It does not identify the Meet participant.** The Meet Add-ons SDK does
  not expose the current user's identity to an add-on (per Google's public
  docs as of this writing); an add-on that needs one runs its own
  auth/OAuth flow, which this shell does not attempt. Given the point above,
  there is currently no path from "a Meet participant opens this panel" to
  "a `sub` naming them" at all.
- **Its Meet Add-ons SDK bootstrap is best-effort, not verified.** The script
  tag, the `createAddonSession`/`createSidePanelClient` call shape, and even
  which manifest fields Google's current schema actually accepts were taken
  from public documentation, not exercised against a live Meet session or a
  Workspace Marketplace SDK project — this repo has neither (see **G6**
  below). `panel.html` is written so a wrong or failed SDK call degrades to
  "the iframe still renders," never to "the panel is dark," but "degrades
  gracefully" is not the same claim as "is correct."
- **The domain is a placeholder.** `manifest.json` and `panel.html` both
  point at `https://board-6b415.web.app` (this Firebase project's default
  Hosting domain) — but `firebase.json` in this repo has **no `hosting`
  block configured**, so nothing is actually confirmed to be served there
  today. Confirm (or add) real web hosting before submission, and update
  both files together — they are not templated from one source yet.

## G6 (marketplace accounts) — what is parked and why

Everything above that says "not verified" needs a real Google Workspace
Marketplace SDK project and a live Meet call to check, neither of which this
task has access to. Specifically parked:

- The manifest actually validating against Google's current schema/tooling.
- The `panel.html` SDK bootstrap actually running inside a real Meet side
  panel (script URL, `createAddonSession` shape, load-signal timing).
- The brief's own checklist item — **a second user editing from inside a
  Meet panel with correct attribution** — end to end. What's verified instead,
  by unit test, is the client-side half that doesn't need a live host: scope
  parsing (`src/lib/__tests__/embedScope.test.ts`), the toolbar/pen-options
  gating on an edit-scope embed and the image/save exclusions
  (`src/components/__tests__/Toolbar.test.tsx`), and the cursor-publish
  carve-out (`src/hooks/__tests__/useBoardCollab.test.ts`). The remaining,
  genuinely-live-only half — does a real Meet participant's browser actually
  reach this panel, and does the panel actually get a working token — has no
  test double for "a Google Workspace Marketplace SDK project" and cannot be
  faked honestly.

None of the above blocks committing this shell. It blocks *submitting* it.

## BLOCKER — do not enable an editable embed for a real host yet

Recorded when Month 5's editable embed landed, and repeated here verbatim
because it is easy to lose in a later diff: an exchanged embed session
outlives every control that appears to bound it.

`exchangeEmbedToken` mints a Firebase custom token; `signInWithCustomToken`
then establishes a durable Auth session whose refresh token **outlives the
5-minute edit token**, is **not** invalidated by re-minting a new token, and
is **not** revoked by rotating `EMBED_JWT_SECRET`. So a leaked editable embed
link yields board write access with **no revocation path anywhere in this
codebase**. See `functions/src/embed/token.ts` (`EMBED_TOKEN_TTL_SECONDS`'s
doc comment) and `docs/functions-deploy-runbook.md` (the embed
secret-rotation and issuer-allowlist sections) for the full detail.

**Do not add `meet` (or any real host) to `EMBED_ALLOWED_ISSUERS` and do not
submit this add-on to the Workspace Marketplace until session revocation
exists**: `auth.revokeRefreshTokens(uid)` reachable from somewhere, an
`auth_time` bound in `firestore.rules`' `isEmbedEditor`, and a host client
(this panel, eventually) that re-exchanges on expiry instead of holding one
Auth session indefinitely. This shell builds none of that — it was out of
scope here and remains open.

## The framing question — who may iframe the embed page today

**Nothing does.** There is no `frame-ancestors` Content-Security-Policy, no
`X-Frame-Options`, and no `hosting` block of any kind in `firebase.json` —
this repo has not configured a response header for any route, embed included.
For the **view** scope this is the intended Month 4 design: a read-only embed
is meant to be framable anywhere. For the **edit** scope it is a materially
different exposure: any origin that obtains a valid edit-scope link — not
only `https://meet.google.com` — can iframe a page holding a write-capable
session, and nothing here restricts that to Meet's own origin.

`manifest.json`'s `addOnOrigins` field is **not** that control — it declares
which origins the add-on's *own* content is hosted at (so Meet trusts loading
*our* page), not which origins may embed us. If this needs bounding before an
editable embed goes live, the right place is a `frame-ancestors` CSP (or
`X-Frame-Options: ALLOW-FROM`, though that header is obsolete in most
browsers) sent by whatever serves `/embed/b/*`, scoped to Meet's origin for
an edit-scope request specifically — view-scope embeds should stay
unrestricted, since being framable anywhere is their whole purpose. Nothing
here builds that: there is no hosting-layer deploy in this repo to attach it
to yet (see the domain-placeholder note above), and a CSP header is not
something a unit test in this repo can verify. This is intentionally left
unbuilt and unclaimed rather than asserted as "handled."
