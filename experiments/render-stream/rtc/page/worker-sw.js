self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/~h/")) {
    event.respondWith(
      new Response(`rtc-worker:${url.searchParams.get("token")}`, {
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      }),
    );
  }
});
