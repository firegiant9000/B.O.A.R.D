"use strict";

/**
 * Month 6 — browser extension shared logic.
 *
 * Plain JS, loaded by BOTH sidepanel.html (`<script src="shared.js">`, before
 * sidepanel.js) and background.js (`importScripts("shared.js")`, which only
 * works because background.js is a CLASSIC service worker — manifest.json's
 * `background` entry deliberately has no `"type": "module"`). One file, not
 * two copies, so sidepanel.js and background.js don't drift from each other.
 *
 * This extension ships with NO bundler and NO new dependencies (see
 * README.md), so it cannot literally `import` the TypeScript modules under
 * src/lib/extension/ — those are Jest-tested and this is where their unit
 * tests live:
 *   - parseEmbedLink        <- src/lib/extension/embedLink.ts
 *   - looksLikeEditScopeToken <- src/lib/extension/tokenScopeGuard.ts
 *   - isSendablePageUrl     <- src/lib/extension/sendablePage.ts
 *   - parseDroppedItem      <- src/lib/extension/droppedItem.ts
 *   - validateExtensionMessage / PAGE_METADATA_MESSAGE <- src/lib/extension/messages.ts
 *   - EDIT_ACTIONS_ENABLED  <- src/lib/extension/editActionsGate.ts
 * Every function below is a byte-for-byte port of its tested twin. Keep them
 * in sync by hand — the same discipline web/meet-addon/README.md already
 * documents for BOARD_ORIGIN. If one of these ever needs to change, change
 * the TypeScript original first, re-run its test, then port the diff here.
 */

// ⚠️ Replace before deploying anywhere — see README.md's "Domain placeholder"
// section. Duplicated in the app's own web/meet-addon/panel.html; keep both
// in sync by hand until this repo templates them from one source.
var BOARD_ORIGIN = "https://board-6b415.web.app";

// ---- editActionsGate.ts -----------------------------------------------
//
// ⛔ OFF BY DESIGN — DO NOT FLIP WITHOUT READING src/lib/extension/editActionsGate.ts.
// An exchanged embed session outlives every control that appears to bound it:
// signInWithCustomToken establishes a Firebase Auth session whose refresh
// token outlives the embed token's own 5-minute expiry, is not invalidated by
// re-minting, and is not revoked by rotating the signing secret. A leaked
// EDITABLE embed link is therefore board write access with no revocation path
// anywhere in this codebase. This panel only ever loads a VIEW-scope link (see
// looksLikeEditScopeToken below), so this stays false and nothing downstream
// of it — the dropped-image and send-this-page actions — ever writes
// anything; both stop at a staged, inert "pending item" card.
var EDIT_ACTIONS_ENABLED = false;

// ---- embedLink.ts -------------------------------------------------------

function parseEmbedLink(input, boardOrigin) {
  var trimmed = input.trim();
  if (!trimmed) return null;

  var url;
  try {
    url = new URL(trimmed);
  } catch (e) {
    return null;
  }

  var origin;
  try {
    origin = new URL(boardOrigin);
  } catch (e) {
    return null;
  }

  if (url.origin !== origin.origin) return null;

  var match = url.pathname.match(/^\/embed\/b\/([^/]+)$/);
  if (!match) return null;

  var boardId = decodeURIComponent(match[1]);
  if (!boardId) return null;

  var token = url.searchParams.get("token");
  if (!token) return null;

  return { boardId: boardId, token: token };
}

// ---- tokenScopeGuard.ts ---------------------------------------------------

function looksLikeEditScopeToken(token) {
  var parts = token.split(".");
  if (parts.length !== 3) return true;

  try {
    var json = base64UrlDecode(parts[1]);
    var payload = JSON.parse(json);
    return payload && payload.scope === "edit";
  } catch (e) {
    return true;
  }
}

function base64UrlDecode(segment) {
  var base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  var padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

// ---- sendablePage.ts ------------------------------------------------------

var BLOCKED_SCHEMES = [
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "extension:",
  "devtools:",
  "view-source:",
  "data:",
];

function isSendablePageUrl(rawUrl, boardOrigin) {
  if (!rawUrl) return false;

  var url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    return false;
  }

  if (BLOCKED_SCHEMES.indexOf(url.protocol) !== -1) return false;

  try {
    if (url.origin === new URL(boardOrigin).origin) return false;
  } catch (e) {
    // an unparsable boardOrigin can't rule anything out
  }

  return true;
}

// ---- droppedItem.ts -------------------------------------------------------

var IMG_SRC = /<img\b[^>]*\ssrc=["']([^"']+)["']/i;

function firstUri(uriList) {
  var lines = uriList.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.length > 0 && line.indexOf("#") !== 0) return line;
  }
  return undefined;
}

function parseDroppedItem(input) {
  if (input.uriList) {
    var uri = firstUri(input.uriList);
    if (uri) return { kind: "image-url", url: uri };
  }

  if (input.html) {
    var match = input.html.match(IMG_SRC);
    if (match) return { kind: "image-url", url: match[1] };
  }

  var file = input.files && input.files[0];
  if (file && file.type.indexOf("image/") === 0) {
    return { kind: "file", name: file.name, type: file.type };
  }

  return null;
}

// ---- messages.ts ------------------------------------------------------

var PAGE_METADATA_MESSAGE = "BOARD_EXT_PAGE_METADATA";

function validateExtensionMessage(raw) {
  if (typeof raw !== "object" || raw === null) return null;

  if (raw.type !== PAGE_METADATA_MESSAGE) return null;
  if (typeof raw.url !== "string" || raw.url === "") return null;
  if (typeof raw.title !== "string") return null;
  if (raw.image !== undefined && (typeof raw.image !== "string" || raw.image === "")) {
    return null;
  }

  var out = { type: PAGE_METADATA_MESSAGE, url: raw.url, title: raw.title };
  if (typeof raw.image === "string") out.image = raw.image;
  return out;
}
