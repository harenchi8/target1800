// CSS/JS更新が反映されやすいようにバージョンを上げる
const CACHE_NAME = "target1800-cache-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/icon-maskable.svg",
  "./data/target1800.min.json",
  "./src/app.js",
  "./src/ui.js",
  "./src/router.js",
  "./src/data.js",
  "./src/db.js",
  "./src/srs.js",
  "./src/logic.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // SPA: ナビゲーションは index.html にフォールバック
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match("./index.html");
        if (cached) return cached;
        return fetch(req);
      })()
    );
    return;
  }

  // 静的ファイルは「Stale-While-Revalidate」寄り（まずキャッシュ、裏で更新）
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req); // ignoreSearchしない（?v= などで更新しやすく）
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        // 返しつつ裏で更新
        event.waitUntil(fetchPromise);
        return cached;
      }
      const res = await fetchPromise;
      return res || cached || new Response("offline", { status: 503 });
    })()
  );
});


