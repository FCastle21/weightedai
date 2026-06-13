const CACHE_NAME = "weightedai-v4";
const CACHED_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.svg",
  "/icon-512.svg"
];

// Install: cache key files
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHED_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache first, fall back to network
self.addEventListener("fetch", event => {
  // Don't cache API calls
  if (event.request.url.includes("/.netlify/") || 
      event.request.url.includes("anthropic.com") ||
      event.request.url.includes("supabase.co")) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        // Cache new successful GET requests
        if (event.request.method === "GET" && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match("/index.html"))
  );
});
