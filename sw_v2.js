"use strict";

/* SpeakTiger v9 offline shell.
   Navigations are cache-first and refreshed in the background. The API is on
   another origin and is never intercepted by this worker. */

const APP_CACHE_PREFIX = "speaktiger-speedfriending-shell-";
const CACHE_NAME = `${APP_CACHE_PREFIX}v2`;
const NETWORK_TIMEOUT_MS = 8000;
const CACHE_READ_TIMEOUT_MS = 8000;

const SCOPE_URL = new URL(self.registration.scope);
const SHELL_URL = new URL("index_7.html", SCOPE_URL);
SHELL_URL.search = "";
SHELL_URL.hash = "";
const SHELL_KEY = SHELL_URL.href;
const APP_ROOT_PATH = SCOPE_URL.pathname;
const APP_INDEX_PATH = SHELL_URL.pathname;

function isCacheableHtml(response) {
  const contentType = response.headers.get("content-type") || "";
  return response.ok && /^text\/html(?:;|$)/i.test(contentType.trim());
}

async function fetchShellWithDeadline() {
  const controller = new AbortController();
  let timer = null;
  let expired = false;

  const operation = (async () => {
    const response = await fetch(SHELL_KEY, {
      cache: "reload",
      credentials: "same-origin",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });

    if (!isCacheableHtml(response)) {
      throw new Error(`Invalid shell response: ${response.status}`);
    }

    /* Reading a clone makes the deadline cover the entire response body,
       while preserving the original response for Cache Storage/the page. */
    await response.clone().arrayBuffer();
    if (expired) throw new Error("Shell fetch timed out");
    return response;
  })();

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error("Shell fetch timed out"));
      try { controller.abort(); } catch (_) {}
    }, NETWORK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function storeShell(response) {
  const copy = response.clone();
  const cache = await caches.open(CACHE_NAME);
  await cache.put(SHELL_KEY, copy);
}

async function readCachedShellWithDeadline() {
  let timer = null;
  const read = (async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(SHELL_KEY);
  })();
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), CACHE_READ_TIMEOUT_MS);
  });

  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function firstSuccessfulResponse(promises) {
  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    let lastError = new Error("No response available");

    for (const promise of promises) {
      Promise.resolve(promise).then(resolve, (error) => {
        lastError = error;
        remaining--;
        if (remaining === 0) reject(lastError);
      });
    }
  });
}

function offlineResponse() {
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#111318">
<title>SpeakTiger — Offline</title>
<style>
  body { margin: 2rem; background: #111318; color: #f2f4f8;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
</style>
<h1>SpeakTiger is offline</h1>
<p>Open this page once while connected so it can be kept for offline use.</p>`,
    {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}

function isAppNavigation(request) {
  if (request.method !== "GET" || request.mode !== "navigate") return false;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin) return false;
  return url.pathname === APP_INDEX_PATH || url.pathname === APP_ROOT_PATH;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const response = await fetchShellWithDeadline();
    await storeShell(response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) =>
          name.startsWith(APP_CACHE_PREFIX) && name !== CACHE_NAME
        )
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (!isAppNavigation(event.request)) return;

  /* The navigation only waits for this bounded network promise. Cache Storage
     work continues under waitUntil and cannot extend the response deadline. */
  const fresh = fetchShellWithDeadline();
  const cacheUpdate = fresh.then(
    (response) => storeShell(response),
    () => undefined
  );
  event.waitUntil(cacheUpdate.then(() => undefined, () => undefined));

  event.respondWith((async () => {
    const cached = readCachedShellWithDeadline().then((response) => {
      if (!response || !isCacheableHtml(response)) {
        throw new Error("No valid cached shell");
      }
      return response;
    });

    try {
      /* A fast valid cache wins. If either source fails, keep waiting for the
         other one until its own bounded deadline. */
      return await firstSuccessfulResponse([cached, fresh]);
    } catch (_) {
      return offlineResponse();
    }
  })());
});
