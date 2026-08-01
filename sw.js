/* SpeakTiger — offline shell, v2.
   Network attempt is DEADLINE-BOUNDED: if the network is wedged, we fall back
   to cache quickly instead of hanging the page load. Cross-origin requests
   (the Worker API) are never intercepted. */

const CACHE   = "speaktiger-shell";
const NET_MS  = 3500;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("sw-deadline")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch the API

  event.respondWith((async () => {
    try {
      const res = await withDeadline(fetch(req), NET_MS);
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    } catch (e) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const shell = await caches.match("./", { ignoreSearch: true });
      if (shell) return shell;
      return new Response("Offline", {
        status: 503, headers: { "Content-Type": "text/plain" }
      });
    }
  })());
});
