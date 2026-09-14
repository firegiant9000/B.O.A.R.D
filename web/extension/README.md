# Browser extension (Chrome + Edge) — Month 6, ROADMAP.md's Month 6 integrations item

Manifest V3 side panel that wraps the M4/M5 embed route (`app/embed/b/[id].tsx`),
plus a "send this page to B.O.A.R.D" context-menu action and a drag-an-image
drop zone in the panel itself. Read this file before loading it or changing
what it's wired to do — several things below are deliberately unfinished, and
the section marked **BLOCKER** is a release gate, not a suggestion.

**LTI 1.3 is not this, and is not started here.** Per ROADMAP.md it needs OIDC
third-party-initiated login, JWKS rotation, Deep Linking 2.0, grade passback,
and Names & Roles, plus a partner application and an LMS admin — parked at
M7+.

## What exists here

- `manifest.json` — Manifest V3: a side panel (no popup — the toolbar icon
  opens the panel directly), a background service worker, a context-menu
  item, and only `activeTab` + `scripting` for host access (no
  `host_permissions`, no persistent `content_scripts` entry — see
  `background.js`'s header for why that's enough).
- `sidepanel.html` / `sidepanel.js` — the panel itself. A link input (paste an
  embed link copied from the app's Share ▸ "Embed (read-only)" action), the
  iframed board, a drop zone for dragged images, and a "pending item" card for
  both write-shaped actions (see **The security constraint** below).
- `background.js` — opens the side panel on toolbar-icon click; registers
  "Send this page to B.O.A.R.D" as a page context-menu item; on click,
  injects `content.js` on demand to collect the tab's title/URL/`og:image`
  and relays it to the panel.
- `content.js` — the on-demand metadata collector `background.js` injects.
  Never declared in `manifest.json`'s `content_scripts`, so it never runs on
  a page the user hasn't just explicitly asked it to via the context-menu
  click.
- `shared.js` — plain-JS ports of the pure logic that has a Jest-tested
  TypeScript original under `src/lib/extension/` (this extension has no
  bundler and cannot import those modules directly — see its own header).
  Loaded by both `sidepanel.html` and `background.js` (via `importScripts`)
  so the two don't hold separate, drifting copies.

## The security constraint this design is built around

**An exchanged embed session outlives every control that appears to bound
it.** `signInWithCustomToken` establishes a durable Firebase Auth session
whose refresh token outlives the 5-minute edit token, is not invalidated by
re-minting, and is not revoked by rotating the signing secret (see
`EMBED_EDIT_TOKEN_TTL_SECONDS` in `functions/src/embed/token.ts`). A leaked
*editable* embed link is therefore board write access with **no revocation
path anywhere in this codebase**. This is the same standing ruling recorded
in `web/meet-addon/README.md`'s BLOCKER section for the Meet add-on; it
applies here without modification.

**What that means for this extension, concretely:**

- The panel only ever loads a **view-scope** embed link — the one
  `ShareBoardModal`'s "Embed (read-only)" action produces
  (`createEmbedLink` in `src/services/embedService.ts` never requests
  `scope: "edit"`). There is no path in this extension that mints or accepts
  an edit-scope link as normal operation.
- `looksLikeEditScopeToken` (`src/lib/extension/tokenScopeGuard.ts`, mirrored
  in `shared.js`) is a **second, independent** check: it peeks (without
  verifying the signature — it can't, it has no secret) at a pasted token's
  own `scope` claim and refuses to load anything that isn't provably `view`.
  This is advisory UI behavior, not the security boundary — the real boundary
  is the server-side exchange and `firestore.rules`' `isEmbedEditor` — but it
  means this panel won't become a second surface edit scope can be exercised
  from even if a future edit-scope share UI or a leaked host-integration link
  ever reached it.
- `EDIT_ACTIONS_ENABLED` (`src/lib/extension/editActionsGate.ts`, mirrored in
  `shared.js`) is `false`. **Both** of this extension's headline write-shaped
  actions — a dropped image, and "send this page to B.O.A.R.D" — stop at a
  staged, inert "pending item" card in the panel. Neither calls anything.
  Read that module's own doc comment before flipping it; it names exactly
  what has to exist first (`auth.revokeRefreshTokens`, an `auth_time` bound in
  `isEmbedEditor`, a re-exchange client), and notes that even after that,
  actually writing from the extension needs the Firebase JS SDK bundled into
  it — a dependency this task deliberately does not add.

**Which capabilities need edit scope and which don't**, for whoever decides
whether the revocation work is worth doing before launch:

| Capability | Needs edit scope? |
|---|---|
| Opening/viewing a board in the side panel | No — wired, default, and the only path |
| Detecting a dropped image and showing it as a pending item | No |
| Detecting "send this page" and showing it as a pending item | No |
| **Actually adding** a dropped image to the board | **Yes** — gated off |
| **Actually adding** a sent page (as a link/note element) to the board | **Yes** — gated off |

The side panel's read-only half is not, in my judgment, worthless: viewing a
board beside an arbitrary page (reference material, a shared study board next
to lecture notes) is a real, if smaller, use case on its own. But the two
capabilities ROADMAP.md's item actually describes — drag-an-image-onto-the-
board and send-this-page-to-a-board — are, at the point they'd create board
content, edit-scope operations, and this build does not wire that point.

## What this does NOT do (and why)

- **It does not write anything to a board.** See the section above.
- **It has not been loaded unpacked and exercised in a real browser.** This
  was authored and unit-tested (via its Jest-tested twins under
  `src/lib/extension/`) in an environment with no browser to drive — there is
  no way to honestly claim "load unpacked, verify drag-to-board across two
  users" was performed, and ROADMAP.md's checklist item to that effect is
  unverified for that reason **in addition to** edit scope being
  intentionally unwired. Load it unpacked (`chrome://extensions` →
  Developer mode → "Load unpacked" → this directory) and sanity-check the
  panel, the link paste, and the drop zone before relying on this further.
- **The domain is a placeholder.** `shared.js`'s `BOARD_ORIGIN` points at
  `https://board-6b415.web.app`, duplicating `web/meet-addon/panel.html`'s
  same placeholder and the same caveat: confirm (or add) real web hosting
  before this matters, and keep the two in sync by hand.
- **There are no extension icons.** `manifest.json` omits `icons`/
  `default_icon` rather than fabricate placeholder image bytes; Chrome shows
  a generic icon for an unpacked extension without one. Add real icons before
  a Web Store submission.
- **It is not submitted anywhere.** See the Chrome Web Store gate below.

## Chrome Web Store gate

Per ROADMAP.md's integration-cost table, a Chrome Web Store developer account
is a **$5 one-time** fee not yet paid, and per this task's own gate this
ships unlisted / load-unpacked in parallel with, not blocked on, that
listing. Submitting to the Web Store additionally means: real icons, a
privacy-practices disclosure (this extension requests `activeTab` +
`scripting` + `storage` + `contextMenus`, no host permissions, and sends
tab title/URL/og:image to the side panel only — never to a third party), and
requesting review of the `manifest.json` permissions actually used. None of
that is done here.
