/* SpeakTiger — offline shell, v3.

   Two changes from v2:
   1. The cache name carries a version, so a redeploy replaces the old build
      instead of serving yesterday's HTML forever.
   2. The page can hand over the full asset list on first load, so every
      screen's artwork is stored before it is needed. A phone that drops off
      the network during round 2 still has the image for round 9.

   Network attempt stays DEADLINE-BOUNDED: if the network is wedged we fall
   back to cache quickly instead of hanging the page load. Cross-origin
   requests (the Worker API) are never intercepted. */

const PREFIX  = "speaktiger-shell";
const VERSION = "v3";
const CACHE   = PREFIX + "-" + VERSION;
const NET_MS  = 3500;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
  );
  await self.clients.claim();
})()));

/* Individual adds rather than addAll: one missing image must not throw away
   the whole set. */
self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "precache" || !Array.isArray(d.assets)) return;
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const url of d.assets) {
      try { await c.add(new Request(url, { cache: "reload" })); } catch (err) {}
    }
  })());
});

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

      /* Only successful responses are allowed into the cache. fetch() does not
         reject on 404 or 500, so without this a deploy window — Netlify and
         GitHub Pages both have one — could write a 404 page over the shell.
         Offline, the app would then BE that 404 page. */
      if (res.ok) {
        const copy = res.clone();
        event.waitUntil(
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
        );
        return res;
      }

      /* A server error on a page load: a working stale shell beats a live
         error page. 404 is deliberately left alone so a genuinely wrong path
         still shows up as wrong instead of being masked. */
      if (res.status >= 500) {
        const hit = await caches.match(req, { ignoreSearch: true })
                 || await caches.match("./", { ignoreSearch: true });
        if (hit) return hit;
      }
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
