(function attachPaiDatabase(global) {
  'use strict';

  const DB_NAME = 'pai-offline';
  const DB_VERSION = 1;
  const STORES = Object.freeze({ PROVAS: 'provas', RESPOSTAS: 'respostas', FILA: 'filaSincronizacao' });

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Falha no IndexedDB.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Transação IndexedDB falhou.'));
      transaction.onabort = () => reject(transaction.error || new Error('Transação IndexedDB foi cancelada.'));
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORES.PROVAS)) {
          database.createObjectStore(STORES.PROVAS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORES.RESPOSTAS)) {
          const store = database.createObjectStore(STORES.RESPOSTAS, { keyPath: 'id' });
          store.createIndex('porProva', 'prova_id', { unique: false });
          store.createIndex('porAluno', 'aluno_id', { unique: false });
          store.createIndex('porQuestaoAluno', ['questao_id', 'aluno_id'], { unique: true });
        }
        if (!database.objectStoreNames.contains(STORES.FILA)) {
          const store = database.createObjectStore(STORES.FILA, { keyPath: 'idempotency_key' });
          store.createIndex('porCriacao', 'criado_em', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Não foi possível abrir o IndexedDB.'));
    });
  }

  async function withStore(storeName, mode, action) {
    const database = await open();
    try {
      const transaction = database.transaction(storeName, mode);
      const result = await action(transaction.objectStore(storeName), transaction);
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16);
      return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
  }

  async function saveProva(prova) {
    if (!prova || prova.id === undefined || prova.id === null) throw new TypeError('A prova precisa possuir um id.');
    return withStore(STORES.PROVAS, 'readwrite', async (store) => {
      const value = { ...prova, salvo_em: new Date().toISOString() };
      await requestAsPromise(store.put(value));
      return value;
    });
  }

  async function getProva(id) {
    return withStore(STORES.PROVAS, 'readonly', (store) => requestAsPromise(store.get(id)));
  }

  async function listProvas() {
    return withStore(STORES.PROVAS, 'readonly', (store) => requestAsPromise(store.getAll()));
  }

  async function saveResposta(resposta) {
    const required = ['prova_id', 'questao_id', 'aluno_id'];
    if (!resposta || required.some((field) => resposta[field] === undefined || resposta[field] === null)) {
      throw new TypeError('prova_id, questao_id e aluno_id são obrigatórios.');
    }
    const id = `${resposta.aluno_id}:${resposta.questao_id}`;
    const value = {
      ...resposta,
      id,
      idempotency_key: resposta.idempotency_key || uuid(),
      respondida_em: resposta.respondida_em || new Date().toISOString(),
      versao_cliente: Number(resposta.versao_cliente || 1),
      pendente_sincronizacao: true,
      atualizado_em: new Date().toISOString()
    };
    return withStore(STORES.RESPOSTAS, 'readwrite', async (store) => {
      const previous = await requestAsPromise(store.get(id));
      if (previous && previous.idempotency_key && !resposta.idempotency_key) value.idempotency_key = uuid();
      await requestAsPromise(store.put(value));
      return value;
    });
  }

  async function listRespostasPendentes() {
    return withStore(STORES.RESPOSTAS, 'readonly', async (store) => {
      const all = await requestAsPromise(store.getAll());
      return all.filter((item) => item.pendente_sincronizacao);
    });
  }

  async function markRespostasSincronizadas(keys) {
    const keySet = new Set(keys);
    return withStore(STORES.RESPOSTAS, 'readwrite', async (store) => {
      const all = await requestAsPromise(store.getAll());
      for (const item of all) {
        if (keySet.has(item.idempotency_key)) {
          item.pendente_sincronizacao = false;
          item.sincronizada_em = new Date().toISOString();
          await requestAsPromise(store.put(item));
        }
      }
    });
  }

  async function enqueueSync(payload) {
    if (!payload || !payload.idempotency_key) throw new TypeError('A fila requer idempotency_key.');
    return withStore(STORES.FILA, 'readwrite', async (store) => {
      const item = { ...payload, criado_em: payload.criado_em || new Date().toISOString(), tentativas: Number(payload.tentativas || 0) };
      await requestAsPromise(store.put(item));
      return item;
    });
  }

  async function listSyncQueue() {
    return withStore(STORES.FILA, 'readonly', async (store) => {
      const items = await requestAsPromise(store.getAll());
      return items.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
    });
  }

  async function removeFromSyncQueue(keys) {
    return withStore(STORES.FILA, 'readwrite', async (store) => {
      for (const key of keys) await requestAsPromise(store.delete(key));
    });
  }

  global.PAI_DB = Object.freeze({
    STORES, open, saveProva, getProva, listProvas, saveResposta,
    listRespostasPendentes, markRespostasSincronizadas, enqueueSync,
    listSyncQueue, removeFromSyncQueue
  });
})(globalThis);
