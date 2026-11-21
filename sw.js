"use strict";

const CACHE = "pixelgba-v1.1.0";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./cheats-db.js",
  "./loader.js", "./emulator.min.js", "./emulator.min.css", "./version.json",
  "./en-US.json", "./mgba.json", "./mgba-wasm.data", "./mgba-legacy-wasm.data",
  "./extract7z.js", "./extractzip.js", "./libunrar.js", "./libunrar.wasm",
  "./check.html", "./LICENSE", "./THIRD_PARTY_NOTICES.md"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("pixelgba-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    const fresh = fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    });
    return cached || fresh.catch(() => new Response("Offline asset unavailable", { status: 503 }));
  }));
});
