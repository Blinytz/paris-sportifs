// Service worker minimal : cache du shell applicatif, réseau d'abord pour
// tout le reste (les données Supabase ne sont jamais mises en cache).

// Incrémenter à chaque déploiement qui modifie le shell : l'activation
// purge l'ancien cache et évite de servir des modules JS périmés.
const CACHE = 'paris-sportifs-v4';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.json',
  'js/app.js', 'js/router.js', 'js/supabase.js', 'js/api.js', 'js/ui.js',
  'js/config.js',
  'js/pages/accueil.js', 'js/pages/classement.js', 'js/pages/equipe.js',
  'js/pages/match.js', 'js/pages/mes-paris.js', 'js/pages/reglages.js',
  'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE)
        .map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);
  // Jamais de cache pour Supabase ni les requêtes non-GET
  if (evt.request.method !== 'GET' || url.origin !== location.origin) return;
  evt.respondWith(
    fetch(evt.request)
      .then((reponse) => {
        const copie = reponse.clone();
        caches.open(CACHE).then((cache) => cache.put(evt.request, copie));
        return reponse;
      })
      .catch(() => caches.match(evt.request, { ignoreSearch: true })
        .then((r) => r || caches.match('index.html')))
  );
});
