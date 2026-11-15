// PYNN — Service Worker
// Necessário para o site atender aos critérios de "instalável" (PWA) em
// Chrome/Edge/Android e para permitir abertura básica offline.

const CACHE_NAME = 'pynn-cache-v18';
const APP_SHELL = [
  './',
  './manifest.json',
  './offline.html',
  './pynn-logo.png'
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

// Estratégia: tenta a rede primeiro; se falhar (offline), usa o cache ou a página offline oficial.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  let reqUrl;
  try {
    reqUrl = new URL(event.request.url);
    if (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') return;
    // O VLibras (gov.br), rotas dinâmicas da API e módulos do dev server não passam pelo cache.
    if (reqUrl.hostname.endsWith('vlibras.gov.br')) return;
    if (reqUrl.pathname.startsWith('/api/')) return;
    if (reqUrl.pathname.startsWith('/@vite') || reqUrl.pathname.startsWith('/@fs/')) return;
  } catch (e) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok && response.status === 200 && reqUrl.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone).catch(() => {});
          });
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return caches.match('./offline.html').then((off) => off || Response.error());
          }
          return Response.error();
        })
      )
  );
});
