const CACHE_NAME = "weightedai-v10";

// Only cache static assets, NEVER cache index.html
const STATIC_ASSETS = [
  "/manifest.json",
  "/icon-192.svg",
  "/icon-512.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  
  // Always fetch HTML fresh from network - never cache it
  if (url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Don't cache API calls
  if (url.pathname.includes("/.netlify/") || 
      url.hostname.includes("anthropic.com") ||
      url.hostname.includes("supabase.co")) {
    return;
  }

  // Cache static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request);
    })
  );
});
