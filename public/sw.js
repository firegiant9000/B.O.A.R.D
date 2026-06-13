/*
 * B.O.A.R.D service worker (Month 2, Phase 5 — PWA).
 *
 * Hand-rolled on purpose: avoids pulling in Workbox / a metro SW plugin (a new
 * dependency that CLAUDE.md would gate on approval) while still satisfying the
 * Lighthouse installability check (registered SW + offline navigation fallback).
 *
 * Caching strategy, deliberately conservative to avoid serving stale app code:
 *   - navigation requests (HTML)  -> network-first, fall back to cached shell
 *   - same-origin static icons     -> cache-first (immutable, versioned by name)
 *   - everything else (JS bundle,  -> network-first, fall back to cache when
 *     Firebase, etc.)                 offline. Cross-origin opaque responses are
 *                                      passed straight through (never cached).
 *
 * Bump CACHE_VERSION on any change here so old caches are purged on activate.
 */
const CACHE_VERSION = "board-v1";
const APP_SHELL = "/";
const PRECACHE = [APP_SHELL, "/manifest.json", "/icons/icon-1024.png"];

self.addEventListener("install", (event) => {
  // Pre-cache the app shell so a cold offline launch still boots.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE))
  );
  // Take over without waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Drop caches from prior versions.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GETs; let writes (POST to Firebase, etc.) pass through untouched.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // SPA navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut(request, response.clone());
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match(APP_SHELL)))
    );
    return;
  }

  // Static, content-addressed icons: cache-first (cheap, rarely changes).
  if (sameOrigin && url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            cachePut(request, response.clone());
            return response;
          })
      )
    );
    return;
  }

  // Same-origin assets (JS bundle, manifest): network-first for freshness, with
  // a cached fallback so a flaky connection still renders. Cross-origin requests
  // fall through to the default handler so we never cache opaque responses.
  if (sameOrigin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut(request, response.clone());
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});

function cachePut(request, response) {
  // Only cache complete, basic (same-origin) 200s; skip partial/opaque/error.
  if (!response || response.status !== 200 || response.type !== "basic") return;
  caches.open(CACHE_VERSION).then((cache) => cache.put(request, response));
}
