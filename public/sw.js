const CACHE_NAME = "biblija365-astro-v3";
const PRECACHE_ASSETS = [
  "/",
  "/plan/",
  "/pretraga/",
  "/oznake/",
  "/styles.css",
  "/astro-client.js",
  "/manifest.json",
  "/data/json/books.json",
  "/data/json/plans/index.json",
  "/data/json/plans/mb-tematski-365.json",
  "/data/json/plans/mb-usporedni-365.json",
  "/data/json/plans/mb-linearni-365.json",
  "/data/audit_report.json"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const hadOldCache = keys.some((k) => k !== CACHE_NAME);
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
      if (hadOldCache) {
        const windowClients = await self.clients.matchAll({ type: "window" });
        for (const client of windowClients) {
          client.navigate("/");
        }
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") {
    return;
  }

  // Network-first strategy with offline cache fallback so UI updates are always immediate
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
