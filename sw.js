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
const VERSION = "v4";   // bump whenever artwork changes: images are cache-first
const CACHE   = PREFIX + "-" + VERSION;
const NET_MS  = 3500;

/* The shell is cached here, not left to the page's precache message. Whether
   the app opens at all offline must not depend on message timing across a
   worker upgrade — that is a single point of failure for the one asset that
   matters most. Images still come from the page's list. */
self.addEventListener("install", (e) => e.waitUntil((async () => {
  try {
    const c = await caches.open(CACHE);
    await c.add(new Request("./", { cache: "reload" }));
  } catch (err) {}
  await self.skipWaiting();
})()));

self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))
  );
  await self.clients.claim();
})()));

/* Individual adds rather than addAll: one missing image must not throw away
   the whole set. */
/* The build the page last precached, and the assets whose refresh for that
   build has not yet succeeded. Both live inside the cache so they survive the
   worker being restarted. */
const BUILD_KEY = "/__build";
const PENDING_KEY = "/__pending";

let precacheBusy = false;

self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "precache" || !Array.isArray(d.assets)) return;
  /* Two overlapping runs would both see an empty cache and fetch everything
     twice. Guarding here rather than in the page keeps it correct however many
     times the page asks. */
  if (precacheBusy) return;
  precacheBusy = true;
  e.waitUntil((async () => {
   try {
    const c = await caches.open(CACHE);

    const build = d.build || "";
    let seen = null, pending = null;
    try {
      const rec = await c.match(BUILD_KEY);
      if (rec) seen = await rec.text();
      const pen = await c.match(PENDING_KEY);
      if (pen) pending = JSON.parse(await pen.text());
    } catch (err) {}

    const fresh = seen !== build;
    /* On a new build everything needs refreshing. On a repeat visit only what
       did not manage it last time — a failed refresh used to be forgotten, so
       one dropped request left a device on the previous artwork for the rest
       of the build. Missing assets were always retried; changed ones were not. */
    const todo = fresh ? d.assets.slice()
                       : (Array.isArray(pending) ? pending : []);
    const stillPending = [];

    /* Every load used to refetch all 26 assets with cache:"reload" — about
       2.6MB per device per load, which is the opposite of what making images
       cache-first was for. */
    for (const url of d.assets) {
      const needsRefresh = todo.indexOf(url) !== -1;
      try {
        if (!needsRefresh && (await c.match(url, { ignoreSearch: true }))) continue;
        /* add() fetches first and only writes on success, so a failure leaves
           the previous copy in place. A stale image beats no image offline. */
        await c.add(new Request(url, { cache: needsRefresh ? "reload" : "default" }));
      } catch (err) {
        if (needsRefresh) stillPending.push(url);
      }
    }

    try {
      await c.put(BUILD_KEY, new Response(build));
      await c.put(PENDING_KEY, new Response(JSON.stringify(stillPending)));
    } catch (err) {}
   } finally { precacheBusy = false; }
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

  /* Images are cache-first; everything else stays network-first.
     Precaching alone did not stop a round trip per screen, because every
     request went to the network first and only fell back to the cache when
     that failed — so artwork was downloaded up front and then fetched again
     each time a screen appeared. A named image file never changes under the
     same name, so serving it from cache on sight is safe. The shell must stay
     network-first or a redeploy would never reach anyone.
     The cost: a replaced image will not reach a device until VERSION moves. */
  if (req.destination === "image") {
    event.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await withDeadline(fetch(req), NET_MS);
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
        }
        return res;
      } catch (e) {
        return new Response("", { status: 504 });   // the <img> onerror shows the placeholder
      }
    })());
    return;
  }

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
