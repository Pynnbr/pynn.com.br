// PYNN — Service Worker
// Necessário para o navegador liberar o prompt "Instalar app" no Android/iOS.
//
// IMPORTANTE: sempre que você publicar uma nova versão do site, mude o
// número da CACHE_NAME abaixo (v2, v3, v4...). Isso faz o navegador perceber
// que este arquivo mudou e disparar a atualização do app instalado.
const CACHE_NAME = 'pynn-cache-v2';
const CORE_ASSETS = [
  './',
  './index.html'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const isHTML =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    event.request.url.endsWith('/') ||
    event.request.url.endsWith('index.html');

  if (isHTML) {
    // Rede primeiro: sempre que houver internet, busca a versão mais nova
    // do site. Só usa o cache se o usuário estiver offline.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Demais arquivos (ícones, fontes, etc.): cache primeiro, com atualização
  // silenciosa em segundo plano.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
