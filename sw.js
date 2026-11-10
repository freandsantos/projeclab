/* Projeclab Studios - tiny service worker so the app can be installed on a phone or tablet.
   It never serves an old copy when you're online: pages always come fresh from the
   network. The last copy is only used to open the app when there's no internet.
   Supabase, Slack and every other request go straight through untouched. */
var CACHE = "ps-shell-v1";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put("/", copy); }); }
    return res;
  }).catch(function () {
    return caches.match("/").then(function (r) {
      return r || new Response("<p style='font-family:sans-serif;padding:40px'>You're offline. Connect to the internet and open Projeclab again.</p>", { headers: { "Content-Type": "text/html" } });
    });
  }));
});
