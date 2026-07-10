// PYNN — Service Worker
// Necessário para o site atender aos critérios de "instalável" (PWA) em
// Chrome/Edge/Android e para permitir abertura básica offline.

const CACHE_NAME = 'pynn-cache-v1';
const APP_SHELL = [
  './',
  './manifest.json'
];

// Instala o SW e faz cache do "app shell" (HTML principal e manifest).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Se algum arquivo não existir/for renomeado, não trava a instalação.
      });
    })
  );
  self.skipWaiting();
});

// Remove caches antigos quando uma nova versão do SW assume o controle.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Estratégia: tenta a rede primeiro; se falhar (offline), usa o cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone).catch(() => {});
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
