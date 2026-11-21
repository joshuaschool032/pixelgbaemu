"use strict";

importScripts("./build-info.js");

const BUILD = self.PIXELGBA_BUILD;
const CACHE = "pixelgba-" + BUILD.id;
const ASSETS = BUILD.assets;

self.addEventListener("install", (event) => {
  // Stay in waiting when an older worker controls the page. The UI asks before
  // activating, which avoids mixing an old shell with a new runtime mid-session.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("pixelgba-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => new Response("Offline asset unavailable", { status: 503 }));
  }));
});
