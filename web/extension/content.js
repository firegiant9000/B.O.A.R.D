"use strict";

/**
 * Month 6 — on-demand page-metadata collector for "send this page to
 * B.O.A.R.D". Injected via chrome.scripting.executeScript ONLY when the user
 * explicitly invokes the "Send this page to B.O.A.R.D" context-menu action
 * (background.js) — this file is NOT declared as a `content_scripts` entry in
 * manifest.json, so it never runs on a page the user hasn't just asked it to.
 *
 * Its return value (the completion value of this script) becomes
 * `results[0].result` for whoever called executeScript (background.js). The
 * shape returned must match shared.js's PAGE_METADATA_MESSAGE contract
 * (mirroring src/lib/extension/messages.ts's PageMetadataMessage) — background.js
 * relays it verbatim to the side panel, which validates it again on arrival
 * (validateExtensionMessage) rather than trusting this script's output as-is.
 */
(function collectPageMetadata() {
  function metaContent(selector) {
    var el = document.querySelector(selector);
    return el ? el.getAttribute("content") : null;
  }

  var ogImage =
    metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');

  var message = {
    type: "BOARD_EXT_PAGE_METADATA",
    url: document.location.href,
    title: document.title || document.location.href,
  };
  if (ogImage) message.image = ogImage;
  return message;
})();
