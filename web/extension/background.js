"use strict";

/**
 * Month 6 — browser extension background service worker (Manifest V3,
 * classic — no `"type": "module"` in manifest.json, which is what makes
 * `importScripts` below work).
 *
 * Two jobs:
 *   - Make the toolbar icon open the side panel (sidepanel.html IS the whole
 *     "wrap the M4 embed" surface — no default_popup is declared).
 *   - Offer "Send this page to B.O.A.R.D" as a context-menu action. Getting a
 *     page's title/og:image needs DOM access this worker doesn't have, so it
 *     injects content.js ON DEMAND via chrome.scripting.executeScript —
 *     never as a persistent `content_scripts` manifest entry — so it runs
 *     only in response to this explicit, user-initiated click, in exactly the
 *     tab the user clicked in. That is also why manifest.json asks only for
 *     "activeTab" + "scripting" rather than a standing host_permissions grant
 *     over every page: this worker (and content.js) can only ever reach a tab
 *     the user just told it to.
 *
 * This worker never mints or holds an embed token and never talks to
 * Firestore/Storage/Firebase Auth. "Send this page" stops at relaying page
 * metadata to the side panel — see sidepanel.js and
 * src/lib/extension/editActionsGate.ts for why it never becomes a write.
 */

importScripts("shared.js");

var SEND_PAGE_MENU_ID = "board-send-page";

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: SEND_PAGE_MENU_ID,
    title: "Send this page to B.O.A.R.D",
    contexts: ["page"],
  });
});

// Without this, clicking the toolbar icon does nothing (no default_popup is
// declared). openPanelOnActionClick makes the existing "action" toolbar icon
// open sidepanel.html directly.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {
  // Non-fatal: the browser's own side-panel menu can still open it manually.
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== SEND_PAGE_MENU_ID || !tab || typeof tab.id !== "number") return;
  // isSendablePageUrl (shared.js, mirroring src/lib/extension/sendablePage.ts)
  // is an advisory UI gate, not a security boundary — there is nothing to
  // protect here since this worker never writes anything either way (see the
  // header above). It just keeps the menu from doing anything on a page that
  // can't sensibly become board content.
  if (!isSendablePageUrl(tab.url, BOARD_ORIGIN)) return;
  relayPageMetadata(tab.id);
});

function relayPageMetadata(tabId) {
  chrome.scripting
    .executeScript({ target: { tabId: tabId }, files: ["content.js"] })
    .then(function (results) {
      var message = results && results[0] && results[0].result;
      if (!message) return;
      // The side panel may not be open/listening yet — sendMessage rejects
      // with "Receiving end does not exist" in that case, which is fine to
      // ignore: there's nothing to relay to.
      return chrome.runtime.sendMessage(message).catch(function () {});
    })
    .catch(function () {
      // The active tab may be one scripting genuinely can't reach (a PDF
      // viewer, the Web Store, …) even though isSendablePageUrl passed it —
      // that check is a URL-shape decision, not a guarantee of injectability.
      // Not a crash either way, just nothing to send.
    });
}
