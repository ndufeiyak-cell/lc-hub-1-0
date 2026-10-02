/* ===== LC Hub Service Worker – Offline + Background Sync ===== */
const CACHE_VERSION = 'lc-hub-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './about.html',
  './events.html',
  './learn.html',
  './research.html',
  './innovate.html',
  './impact.html',
  './contact.html',
  './register.html',
  './login.html',
  './offline.html',
  './css/style.css',
  './js/app.js',
  './manifest.json'
];

const DB_NAME = 'LCHubDB';
const DB_VERSION = 3;
const QUEUE_STORE = 'syncQueue';

// Install – precache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate – clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('lc-hub-') && key !== STATIC_CACHE && key !== PAGES_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  if (request.headers.get('accept')?.includes('text/html') ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('/')) {
    event.respondWith(networkFirstPage(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirstPage(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(PAGES_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const cachedByPath = await caches.match(request.url.split('?')[0]);
    if (cachedByPath) return cachedByPath;
    const offline = await caches.match('./offline.html');
    return offline || new Response('You are offline and this page is not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// ---------- Background Sync ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'lc-hub-sync') {
    event.waitUntil(processSyncQueue());
  }
});

function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('users')) {
        const us = db.createObjectStore('users', { keyPath: 'id' });
        us.createIndex('email', 'email', { unique: true });
        us.createIndex('role', 'role', { unique: false });
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('zoomSessions')) {
        const zs = db.createObjectStore('zoomSessions', { keyPath: 'id' });
        zs.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const qs = db.createObjectStore(QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
        qs.createIndex('status', 'status', { unique: false });
        qs.createIndex('type', 'type', { unique: false });
      }
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'formId' });
      }
      if (!db.objectStoreNames.contains('preferences')) {
        db.createObjectStore('preferences', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('activity')) {
        const act = db.createObjectStore('activity', { keyPath: 'id', autoIncrement: true });
        act.createIndex('at', 'at', { unique: false });
        act.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function processSyncQueue() {
  const db = await openSyncDB();
  const pending = await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const index = tx.objectStore(QUEUE_STORE).index('status');
    const req = index.getAll('pending');
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  if (!pending.length) {
    console.log('[SW] Sync queue empty');
    return;
  }

  console.log('[SW] Processing', pending.length, 'queued item(s)');

  for (const item of pending) {
    try {
      await applySyncItem(db, item);
      // Mark as synced
      await new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_STORE, 'readwrite');
        const store = tx.objectStore(QUEUE_STORE);
        item.status = 'synced';
        item.syncedAt = Date.now();
        store.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error('[SW] Failed to sync item', item.id, err);
      // Leave as pending for next attempt
    }
  }

  // Notify open clients
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => {
    client.postMessage({
      type: 'SYNC_COMPLETE',
      count: pending.length
    });
  });
}

async function applySyncItem(db, item) {
  // In a real app this would POST to your API.
  // Here we apply locally so offline-created data becomes "committed".
  switch (item.type) {
    case 'register': {
      // User was already written optimistically; just confirm
      console.log('[SW] Synced registration for', item.payload.email);
      break;
    }
    case 'contact': {
      // Persist contact message
      await new Promise((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite');
        tx.objectStore('messages').put({
          id: item.payload.id || ('msg_' + Date.now()),
          ...item.payload,
          syncedAt: Date.now()
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      console.log('[SW] Synced contact message from', item.payload.email);
      break;
    }
    case 'event_register': {
      console.log('[SW] Synced event registration', item.payload);
      break;
    }
    default:
      console.log('[SW] Unknown sync type', item.type);
  }
}

// Allow page to trigger sync processing manually
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'PROCESS_SYNC') {
    event.waitUntil(processSyncQueue());
  }
});
