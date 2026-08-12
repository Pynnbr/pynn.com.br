// PYNN — Service Worker
// Necessário para o site atender aos critérios de "instalável" (PWA) em
// Chrome/Edge/Android e para permitir abertura básica offline.

const CACHE_NAME = 'pynn-cache-v6';
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
  // Não chama skipWaiting() automaticamente: a nova versão fica "esperando"
  // até o usuário confirmar no aviso de atualização mostrado na página.
});

// Permite que a página (ao clicar em "Atualizar agora") mande esta versão
// nova assumir o controle imediatamente, sem precisar fechar todas as abas.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
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
