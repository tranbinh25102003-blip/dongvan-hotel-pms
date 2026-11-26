/* ==========================================================================
   Dongvan Hotel PMS — Auto-Updating Service Worker (sw.js)
   - Works identically on root HTTPS domains and GitHub Pages subpaths (./)
   - Strictly bypasses all /api/* and version.json requests
   - Network-First with cache: "no-store" + CLEAR_APP_CACHE message handling
     so existing home-screen icons ALWAYS load the newest deployed version.
   ========================================================================== */

const CACHE_NAME = "dongvan-hotel-shell-v27";
const isHotelCache = key => /^dongvan-hotel-shell-v[0-9]+$/.test(key);
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./mobile.css",
  "./pms-core.js",
  "./folio.js",
  "./folio-ui.js",
  "./control-audit.js",
  "./install-app.js",
  "./ops24.js",
  "./ops24-ui.js",
  "./controls-ui.js",
  "./supabase-config.js",
  "./pms-supabase.js",
  "./pms-client.js",
  "./app.js",
  "./finance-ui.js",
  "./enterprise-report.js",
  "./enterprise-ui.js",
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
          .then((res) => {
            if (!res.ok) throw Error("Thiếu thành phần cài đặt " + u);
            return cache.put(u, res);
          }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => isHotelCache(k) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event && event.data ? event.data : {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CLEAR_APP_CACHE") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.filter(isHotelCache).map((k) => caches.delete(k))))
    );
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;
  const shellFile = PRECACHE_URLS.some(path => new URL(path, self.registration.scope).pathname === reqUrl.pathname);
  if (!shellFile) return;
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
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const asset = await cache.match(event.request, { ignoreSearch: true });
        if (asset) return asset;
        if (event.request.mode === "navigate") {
          const page = await cache.match("./index.html");
          if (page) return page;
        }
        return Response.error();
      })
  );
});
