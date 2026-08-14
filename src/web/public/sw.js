// Installability only — deliberately does no caching whatsoever. The web
// UI is always served fresh from the server (spec #33's version-
// compatibility design: no client-side bundle to go stale, which is why
// Phase 6's version handshake only needed to cover Electron's native
// shell, not this UI). A service worker that cached the app bundle could
// keep serving stale, API-incompatible code after the server moves on to
// a newer protocol version — this one exists purely so the browser's
// installability checks find a registered service worker with a fetch
// handler; every request still goes straight to the network.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
