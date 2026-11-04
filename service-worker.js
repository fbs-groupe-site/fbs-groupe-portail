"use strict";

const CACHE_NAME = "fbs-formation-production-v1";
const APP_FILES = [
  "./index.html",
  "./app.css",
  "./app-production.js",
  "./production.css",
  "./supabase-config.js",
  "./manifest.webmanifest",
  "./IMAGES/Logo.png",
  "./IMAGES/FBS2.jpeg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith("fbs-formation-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok && (new URL(request.url).pathname.endsWith("/") || new URL(request.url).pathname.endsWith("index.html"))) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request).then((cached) => {
      if (cached) return cached;
      if (request.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    }))
  );
});
