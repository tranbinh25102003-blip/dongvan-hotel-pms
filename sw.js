/* ==========================================================================
   Dongvan Hotel PMS — Auto-Updating Service Worker (sw.js)
   - Works identically on root HTTPS domains and GitHub Pages subpaths (./)
   - Strictly bypasses all /api/* and version.json requests
   - Network-First with cache: "no-store" + CLEAR_APP_CACHE message handling
     so existing home-screen icons ALWAYS load the newest deployed version.
   ========================================================================== */

const CACHE_NAME = "dongvan-hotel-shell-v20";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./mobile.css",
  "./pms-core.js",
  "./supabase-config.js",
  "./pms-supabase.js",
  "./pms-client.js",
  "./app.js",
  "./finance-ui.js",
  "./mobile.js",
  "./logo.jpg",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((u) => fetch(u, { cache: "no-store" })
          .then((res) => (res && res.ok ? cache.put(u, res) : null))
          .catch(() => null))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event && event.data ? event.data : {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CLEAR_APP_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;
  // Never intercept or cache API calls, auth endpoints, version checks, or SSE streams
  if (reqUrl.pathname.startsWith("/api/") || reqUrl.pathname.endsWith("/version.json")) return;

  // Network-first with no-store: always pick up newly deployed version immediately when online
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((networkRes) => {
        if (networkRes && networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./") || caches.match("./index.html")))
  );
});
