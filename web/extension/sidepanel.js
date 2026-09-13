"use strict";

/**
 * Month 6 — browser extension side panel logic. Loaded after shared.js (see
 * sidepanel.html), whose globals (parseEmbedLink, looksLikeEditScopeToken,
 * isSendablePageUrl, parseDroppedItem, validateExtensionMessage,
 * PAGE_METADATA_MESSAGE, EDIT_ACTIONS_ENABLED, BOARD_ORIGIN) this file uses
 * directly rather than importing — see shared.js's own header for why.
 *
 * This panel has NO B.O.A.R.D-authenticated session of its own and never will
 * — it is a static Manifest V3 page, not a build of the app, so it cannot call
 * `createEmbedLink` (src/services/embedService.ts) to mint a link itself, and
 * it never bundles the Firebase SDK (no new dependencies — see README.md). The
 * ONLY way it opens a board is a link the user copies from the app's existing
 * Share ▸ "Embed (read-only)" action (src/components/ShareBoardModal.tsx) and
 * pastes here — which is why that link is the one and only thing this file
 * ever turns into an iframe `src`, and why `looksLikeEditScopeToken` refuses
 * to load anything that claims otherwise (see that module's own header).
 *
 * The two write-shaped actions this panel offers — a dropped image, or a page
 * relayed from background.js's "Send this page to B.O.A.R.D" context-menu
 * item — both stop at a staged "pending item" card. Neither ever calls
 * anything: see EDIT_ACTIONS_ENABLED in shared.js for why, and
 * src/lib/extension/editActionsGate.ts for the full detail. The "Add to
 * board" button stays `disabled` in the markup for exactly that reason.
 */

var STORAGE_KEY = "boardEmbedLink";

var linkInput = document.getElementById("link-input");
var linkOpenBtn = document.getElementById("link-open");
var statusEl = document.getElementById("status");
var emptyState = document.getElementById("empty-state");
var boardFrame = document.getElementById("board-frame");
var dropOverlay = document.getElementById("drop-overlay");
var pendingItem = document.getElementById("pending-item");
var pendingThumb = document.getElementById("pending-thumb");
var pendingTitle = document.getElementById("pending-title");
var pendingNote = document.getElementById("pending-note");
var pendingDismiss = document.getElementById("pending-dismiss");

function setStatus(message, isError) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", !!isError);
}

function showBoard(boardId, token) {
  var src = BOARD_ORIGIN + "/embed/b/" + encodeURIComponent(boardId) + "?token=" + encodeURIComponent(token);
  boardFrame.src = src;
  boardFrame.style.display = "block";
  emptyState.style.display = "none";
}

/** Parses, scope-guards, and (on success) loads a pasted embed link — the one
 *  path this panel has for opening a board at all. See this file's header. */
function tryOpenLink(rawInput, persist) {
  var parsed = parseEmbedLink(rawInput, BOARD_ORIGIN);
  if (!parsed) {
    setStatus("That doesn't look like a B.O.A.R.D embed link.", true);
    return;
  }
  if (looksLikeEditScopeToken(parsed.token)) {
    // Advisory refusal, not a security boundary — see tokenScopeGuard.ts. The
    // real boundary is the server-side exchange + firestore.rules either way.
    setStatus(
      "This link requests edit access, which this extension doesn't support yet.",
      true
    );
    return;
  }
  setStatus("");
  showBoard(parsed.boardId, parsed.token);
  if (persist) {
    chrome.storage.local.set({ [STORAGE_KEY]: rawInput }).catch(function () {});
  }
}

linkOpenBtn.addEventListener("click", function () {
  tryOpenLink(linkInput.value, true);
});
linkInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") tryOpenLink(linkInput.value, true);
});

// Restore the last-used link on open. chrome.storage.local (never .sync): the
// pasted link carries a short-lived embed token, and keeping it device-local
// rather than synced across the user's signed-in browsers is a small, free
// reduction in how far a stale token travels — not a security boundary (the
// token already expires server-side; see EMBED_TOKEN_TTL_SECONDS), just no
// reason to widen it further than the panel needs.
chrome.storage.local.get([STORAGE_KEY]).then(function (result) {
  var saved = result && result[STORAGE_KEY];
  if (saved) {
    linkInput.value = saved;
    tryOpenLink(saved, false);
  }
}).catch(function () {});

// ---- "Send this page to B.O.A.R.D" (relayed from background.js) ----------

chrome.runtime.onMessage.addListener(function (raw) {
  var message = validateExtensionMessage(raw);
  if (!message) return;
  showPendingItem({
    title: message.title,
    note: message.url,
    thumbUrl: message.image,
  });
});

// ---- Drag-an-image-onto-the-board ------------------------------------

var dragDepth = 0;

document.addEventListener("dragenter", function (e) {
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.add("active");
});
document.addEventListener("dragover", function (e) {
  e.preventDefault();
});
document.addEventListener("dragleave", function () {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.remove("active");
});
document.addEventListener("drop", function (e) {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.remove("active");

  var dataTransfer = e.dataTransfer;
  if (!dataTransfer) return;

  var input = {
    types: Array.prototype.slice.call(dataTransfer.types || []),
    uriList: safeGetData(dataTransfer, "text/uri-list"),
    html: safeGetData(dataTransfer, "text/html"),
    files: Array.prototype.map.call(dataTransfer.files || [], function (f) {
      return { name: f.name, type: f.type };
    }),
  };

  var item = parseDroppedItem(input);
  if (!item) return;

  if (item.kind === "image-url") {
    showPendingItem({ title: "Dropped image", note: item.url, thumbUrl: item.url });
  } else {
    showPendingItem({ title: item.name, note: item.type, thumbUrl: null });
  }
});

function safeGetData(dataTransfer, format) {
  try {
    var value = dataTransfer.getData(format);
    return value || undefined;
  } catch (e) {
    return undefined;
  }
}

// ---- Pending-item card (shared by both actions above) ---------------------

function showPendingItem(item) {
  pendingTitle.textContent = item.title;
  pendingNote.textContent = EDIT_ACTIONS_ENABLED
    ? item.note
    : item.note + " — adding items from the extension isn't enabled in this build yet.";
  if (item.thumbUrl) {
    pendingThumb.src = item.thumbUrl;
    pendingThumb.hidden = false;
  } else {
    pendingThumb.hidden = true;
  }
  pendingItem.classList.add("visible");
}

pendingDismiss.addEventListener("click", function () {
  pendingItem.classList.remove("visible");
});
