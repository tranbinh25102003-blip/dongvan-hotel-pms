/* ==========================================================================
   Dongvan Ville du H'mong Hotel PMS — Auto-Updating Offline Service Worker
   Strategy: Network-First for instant updates whenever online, falling back
   seamlessly to local cache whenever Internet is unavailable.
   ========================================================================== */

const CACHE_NAME = "dongvan-pms-app-v1";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./pms-core.js",
  "./app.js",
  "./logo.jpg",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const reqUrl = new URL(event.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  // Network-first: always get newest deployed version when online; fallback to cache offline
  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((networkRes) => {
        if (networkRes && networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
