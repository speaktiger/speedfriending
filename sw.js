/* SpeakTiger — offline shell.
   Network-first: always prefers the live file, so development never
   serves stale code. Falls back to the cached copy only when offline.
   API calls are never cached (different origin, and skipped explicitly). */

const CACHE = "speaktiger-shell";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch the Worker API

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const shell = await caches.match("./", { ignoreSearch: true });
        if (shell) return shell;
        return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      })
  );
});
