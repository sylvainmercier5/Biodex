// BioDex v0.28 — Service Worker
const CACHE = "biodex-v0-28";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./emblem.png",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"
];

self.addEventListener("install", (e) => {
  // On NE fait plus skipWaiting() automatiquement : le nouveau SW attend en "waiting"
  // jusqu'à ce que l'utilisateur accepte la mise à jour via la bannière.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// L'appli demande l'activation de la nouvelle version (bouton "Mettre à jour")
self.addEventListener("message", (e) => {
  if (e.data === "ACTIVER_MAJ") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Météo : toujours le réseau (données du moment), pas de cache
  if (url.hostname.includes("open-meteo.com")) return;
  if (e.request.method !== "GET") return;
  // App shell + CDN : cache d'abord, réseau en secours (puis mise en cache)
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((resp) => {
          if (resp && resp.status === 200 && (resp.type === "basic" || resp.type === "cors")) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
    )
  );
});
