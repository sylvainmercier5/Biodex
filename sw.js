// BioDex v2.06 — Service Worker
// © 2026 Sylvain Mercier. Tous droits réservés.
const CACHE = "biodex-v2-06";
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
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js"
];

self.addEventListener("install", (e) => {
  // On NE fait plus skipWaiting() automatiquement : le nouveau SW attend en "waiting"
  // jusqu'à ce que l'utilisateur accepte la mise à jour via la bannière.
  // addAll() échoue en bloc si UN seul fichier manque : on met en cache un par un
  // pour qu'un CDN momentanément indisponible n'empêche pas l'installation.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(
    SHELL.map((u) => c.add(u).catch(() => null))
  )));
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

// v1.95 — Notifications push : la fonction « notifier » (Supabase) envoie
// { titre, corps, tag, url }. Un même tag remplace la notification précédente
// (ex. plusieurs réactions sur la même trouvaille) au lieu de les empiler.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { corps: e.data ? e.data.text() : "" }; }
  const titre = d.titre || "BioDex";
  e.waitUntil(self.registration.showNotification(titre, {
    body: d.corps || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || "./" },
  }));
});

// Toucher la notification : on remet l'appli au premier plan (ou on l'ouvre) sur le bon écran.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const cible = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of fenetres) {
      if (c.url.startsWith(self.registration.scope)) {
        try { c.postMessage({ type: "biodex-notif", url: cible }); } catch {}
        return c.focus();
      }
    }
    return self.clients.openWindow(cible);
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // DONNÉES VIVANTES : toujours le réseau, jamais de cache.
  // (mur commun, connexion, config, météo, recherche d'espèces)
  if (
    url.hostname.endsWith("supabase.co") ||            // base de données + auth + photos du mur
    url.pathname.startsWith("/.netlify/functions/") || // config, identification IA
    url.hostname.includes("open-meteo.com") ||          // météo du moment
    url.hostname.includes("inaturalist.org") ||          // autocomplétion espèces
    url.hostname.includes("jsdelivr.net")               // bibliothèque Supabase : jamais en cache
                                                        // (une copie abîmée bloquait toute l'appli)
  ) return;
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
