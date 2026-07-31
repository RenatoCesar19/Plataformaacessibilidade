importScripts('/db.js');

const CACHE_NAME = 'pai-assets-v1';
const ASSET_DESTINATIONS = new Set(['style', 'script', 'font', 'image', 'document']);
const APP_SHELL = ['/manifest.json', '/db.js'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_SHELL.map(async (asset) => {
      try { await cache.add(asset); } catch (error) { console.warn(`Não foi possível pré-cachear ${asset}`, error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && request.method === 'GET') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ erro: 'Sem conexão e sem conteúdo local.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function queueSyncRequest(request) {
  let payload;
  try {
    payload = await request.clone().json();
  } catch (_error) {
    return new Response(JSON.stringify({ erro: 'O corpo da sincronização precisa ser JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const alunoId = payload.aluno_id;
  for (const resposta of payload.respostas || []) {
    if (resposta.idempotency_key) await self.PAI_DB.enqueueSync({ ...resposta, aluno_id: alunoId });
  }
  if (self.registration.sync) {
    try { await self.registration.sync.register('pai-sincronizar-respostas'); } catch (error) { console.warn('Background Sync indisponível.', error); }
  }
  return new Response(JSON.stringify({ pendente: true, mensagem: 'Respostas salvas para sincronização posterior.' }), {
    status: 202,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function flushSyncQueue() {
  const queue = await self.PAI_DB.listSyncQueue();
  if (!queue.length) return;
  const grouped = new Map();
  for (const item of queue) {
    const key = String(item.aluno_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  for (const [alunoId, entries] of grouped) {
    const response = await fetch('/sincronizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aluno_id: Number(alunoId), respostas: entries.map(({ aluno_id, criado_em, tentativas, ...answer }) => answer) })
    });
    if (!response.ok) throw new Error(`Sincronização falhou: ${response.status}`);
    const result = await response.json();
    const keys = (result.sincronizadas || []).map((item) => item.idempotency_key);
    if (keys.length) {
      await self.PAI_DB.removeFromSyncQueue(keys);
      await self.PAI_DB.markRespostasSincronizadas(keys);
    }
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname === '/sincronizar') {
    event.respondWith((async () => {
      try { return await fetch(request.clone()); }
      catch (_error) { return queueSyncRequest(request); }
    })());
    return;
  }
  if (url.pathname === '/provas' || url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }
  if (request.method === 'GET' && (ASSET_DESTINATIONS.has(request.destination) || url.pathname === '/')) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pai-sincronizar-respostas') event.waitUntil(flushSyncQueue());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PAI_FLUSH_SYNC') event.waitUntil(flushSyncQueue());
});
