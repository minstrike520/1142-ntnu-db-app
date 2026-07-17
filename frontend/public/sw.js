const CACHE_PREFIX = "near-chat";
const urlParams = new URL(self.location.href).searchParams;
const VERSION = urlParams.get("v") || "v1";
const PRECACHE_NAME = `${CACHE_PREFIX}-precache-${VERSION}`;
const STATIC_CACHE_NAME = `${CACHE_PREFIX}-static-${VERSION}`;
const PAGE_CACHE_NAME = `${CACHE_PREFIX}-pages-${VERSION}`;
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/near.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  const activeCaches = new Set([
    PRECACHE_NAME,
    STATIC_CACHE_NAME,
    PAGE_CACHE_NAME,
  ]);

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (cacheName) =>
                cacheName.startsWith(`${CACHE_PREFIX}-`) &&
                !activeCaches.has(cacheName),
            )
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function trimCache(cacheName, maxItems) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxItems) {
      for (let i = 0; i < keys.length - maxItems; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch {
    // Failure to trim cache should not crash the service worker
  }
}

async function cacheSuccessfulResponse(cacheName, request, response) {
  if (
    response.ok &&
    response.type === "basic" &&
    !request.headers.has("range")
  ) {
    try {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
      const limit = cacheName === PAGE_CACHE_NAME ? 30 : 150;
      await trimCache(cacheName, limit);
    } catch {
      // A cache quota failure must not turn a successful network response into
      // a failed request.
    }
  }

  return response;
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    return await cacheSuccessfulResponse(PAGE_CACHE_NAME, request, response);
  } catch {
    const fallback =
      (await caches.match(request, { ignoreSearch: true })) ??
      (await caches.match("/offline.html", { ignoreSearch: true }));

    return (
      fallback ??
      new Response("Near is offline", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const response = await fetch(request);
  return cacheSuccessfulResponse(STATIC_CACHE_NAME, request, response);
}

function getSafeAppShellUrls(messageData) {
  if (messageData?.type !== "CACHE_APP_SHELL" || !Array.isArray(messageData.urls)) {
    return [];
  }

  return messageData.urls.slice(0, 100).flatMap((resourceUrl) => {
    if (typeof resourceUrl !== "string") return [];

    try {
      const url = new URL(resourceUrl, self.location.origin);
      return url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")
        ? [url.href]
        : [];
    } catch {
      return [];
    }
  });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_PAGE_CACHE") {
    event.waitUntil(
      caches.delete(PAGE_CACHE_NAME)
    );
    return;
  }

  const appShellUrls = getSafeAppShellUrls(event.data);
  if (appShellUrls.length === 0) return;

  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) =>
      Promise.all(
        appShellUrls.map(async (resourceUrl) => {
          try {
            await cache.add(resourceUrl);
          } catch {
            // One missing chunk must not prevent the remaining app shell from
            // being cached for offline use.
          }
        }),
      ).then(() => trimCache(STATIC_CACHE_NAME, 150)),
    ),
  );
});

function getSafeNotificationUrl(notificationData) {
  const fallbackUrl = new URL("/", self.location.origin);
  const requestedUrl = notificationData?.url;

  if (typeof requestedUrl !== "string") {
    return fallbackUrl.href;
  }

  try {
    const targetUrl = new URL(requestedUrl, self.location.origin);
    return targetUrl.origin === self.location.origin
      ? targetUrl.href
      : fallbackUrl.href;
  } catch {
    return fallbackUrl.href;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = getSafeNotificationUrl(event.notification.data);

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const sameOriginClients = windowClients.filter(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        const targetClient =
          sameOriginClients.find((client) => client.url === targetUrl) ??
          sameOriginClients[0];

        if (!targetClient) {
          return self.clients.openWindow(targetUrl);
        }

        try {
          const navigatedClient =
            targetClient.url === targetUrl
              ? targetClient
              : await targetClient.navigate(targetUrl);
          return (navigatedClient ?? targetClient).focus();
        } catch {
          return targetClient.focus();
        }
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/sw.js") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const isPwaAsset =
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/near.png" ||
    url.pathname.startsWith("/icons/");
  const isStaticAsset =
    url.pathname.startsWith("/_next/static/") || isPwaAsset;

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request));
  }
});
