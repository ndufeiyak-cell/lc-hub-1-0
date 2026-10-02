/* ===== LC Hub - Dynamic App Logic (IndexedDB + Offline + Background Sync) ===== */
(function () {
  'use strict';

  // ---------- IndexedDB layer (offline data persistence) ----------
  const DB_NAME = 'LCHubDB';
  const DB_VERSION = 3;
  const STORES = {
    users: 'users',
    session: 'session',
    zoom: 'zoomSessions',
    syncQueue: 'syncQueue',
    messages: 'messages',
    drafts: 'drafts',
    preferences: 'preferences',
    activity: 'activity'
  };

  // Legacy localStorage keys (for one-time migration)
  const LS_USERS = 'lc_hub_users';
  const LS_SESSION = 'lc_hub_session';
  const LS_ZOOM = 'lc_hub_zoom_sessions';

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains(STORES.users)) {
          const userStore = db.createObjectStore(STORES.users, { keyPath: 'id' });
          userStore.createIndex('email', 'email', { unique: true });
          userStore.createIndex('role', 'role', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.session)) {
          db.createObjectStore(STORES.session, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORES.zoom)) {
          const zoomStore = db.createObjectStore(STORES.zoom, { keyPath: 'id' });
          zoomStore.createIndex('date', 'date', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.syncQueue)) {
          const qs = db.createObjectStore(STORES.syncQueue, { keyPath: 'id', autoIncrement: true });
          qs.createIndex('status', 'status', { unique: false });
          qs.createIndex('type', 'type', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORES.messages)) {
          db.createObjectStore(STORES.messages, { keyPath: 'id' });
        }

        // Form drafts – survive refresh & offline
        if (!db.objectStoreNames.contains(STORES.drafts)) {
          db.createObjectStore(STORES.drafts, { keyPath: 'formId' });
        }

        // App preferences & last-route
        if (!db.objectStoreNames.contains(STORES.preferences)) {
          db.createObjectStore(STORES.preferences, { keyPath: 'key' });
        }

        // Activity / audit log for persistence events
        if (!db.objectStoreNames.contains(STORES.activity)) {
          const act = db.createObjectStore(STORES.activity, { keyPath: 'id', autoIncrement: true });
          act.createIndex('at', 'at', { unique: false });
          act.createIndex('type', 'type', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function idbGetAll(storeName) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbGet(storeName, key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPut(storeName, value) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbDelete(storeName, key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function idbClear(storeName) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPutAll(storeName, items) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  // ---------- Public storage API ----------
  async function getUsers() {
    try {
      return await idbGetAll(STORES.users);
    } catch {
      return [];
    }
  }

  async function saveUsers(users) {
    await idbClear(STORES.users);
    if (users.length) await idbPutAll(STORES.users, users);
  }

  async function addUser(user) {
    await idbPut(STORES.users, user);
  }

  async function getUserByEmail(email) {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.users, 'readonly');
        const index = tx.objectStore(STORES.users).index('email');
        const req = index.get(email);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function getSession() {
    try {
      const record = await idbGet(STORES.session, 'current');
      return record ? record.data : null;
    } catch {
      return null;
    }
  }

  async function setSession(user) {
    if (user) {
      await idbPut(STORES.session, {
        key: 'current',
        data: {
          id: user.id,
          name: user.name,
          email: user.email,
          loggedAt: Date.now()
        }
      });
    } else {
      await idbDelete(STORES.session, 'current');
    }
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function seedZoomData() {
    const now = new Date();
    return [
      {
        id: 1,
        title: 'Introduction to Innovation & Design Thinking',
        date: addDays(now, 3).toISOString().slice(0, 10),
        time: '10:00',
        duration: '90 min',
        host: 'Dr. Amina Okoro',
        zoomLink: 'https://zoom.us/j/1234567890',
        meetingId: '123 456 7890',
        description: 'Learn core principles of design thinking and how to apply them to real-world challenges.'
      },
      {
        id: 2,
        title: 'Research Methods for Impact',
        date: addDays(now, 7).toISOString().slice(0, 10),
        time: '14:00',
        duration: '60 min',
        host: 'Prof. James Mensah',
        zoomLink: 'https://zoom.us/j/2345678901',
        meetingId: '234 567 8901',
        description: 'Practical workshop on qualitative & quantitative research techniques.'
      },
      {
        id: 3,
        title: 'Building Scalable Solutions',
        date: addDays(now, 12).toISOString().slice(0, 10),
        time: '11:00',
        duration: '120 min',
        host: 'Sarah Chen',
        zoomLink: 'https://zoom.us/j/3456789012',
        meetingId: '345 678 9012',
        description: 'From prototype to product: scaling innovations for maximum impact.'
      },
      {
        id: 4,
        title: 'Community Engagement Strategies',
        date: addDays(now, 18).toISOString().slice(0, 10),
        time: '15:30',
        duration: '75 min',
        host: 'Kwame Asante',
        zoomLink: 'https://zoom.us/j/4567890123',
        meetingId: '456 789 0123',
        description: 'How to involve communities in research and innovation cycles.'
      }
    ];
  }

  async function getZoomSessions() {
    try {
      let sessions = await idbGetAll(STORES.zoom);
      if (!sessions.length) {
        sessions = seedZoomData();
        await idbPutAll(STORES.zoom, sessions);
      }
      return sessions;
    } catch {
      return seedZoomData();
    }
  }

  // ---------- Background Sync queue ----------
  async function enqueueSync(type, payload) {
    const item = {
      type,
      payload,
      status: 'pending',
      createdAt: Date.now()
    };

    const db = await openDB();
    const id = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.syncQueue, 'readwrite');
      const req = tx.objectStore(STORES.syncQueue).add(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    item.id = id;
    console.log('[LC Hub] Queued for sync:', type, id);

    // Request Background Sync if supported
    await requestBackgroundSync();

    updateSyncBadge();
    return item;
  }

  async function getPendingSyncCount() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.syncQueue, 'readonly');
        const index = tx.objectStore(STORES.syncQueue).index('status');
        const req = index.count('pending');
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return 0;
    }
  }

  async function getPendingSyncItems() {
    try {
      const db = await openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.syncQueue, 'readonly');
        const index = tx.objectStore(STORES.syncQueue).index('status');
        const req = index.getAll('pending');
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async function requestBackgroundSync() {
    if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
      // Fallback: process when online event fires
      return false;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('lc-hub-sync');
      console.log('[LC Hub] Background Sync registered');
      return true;
    } catch (err) {
      console.warn('[LC Hub] Background Sync not available:', err.message);
      return false;
    }
  }

  /** Process queue from the page context (fallback when SW sync isn't available) */
  async function processSyncQueueLocally() {
    const pending = await getPendingSyncItems();
    if (!pending.length) return 0;

    console.log('[LC Hub] Processing', pending.length, 'queued item(s) locally');
    let done = 0;

    for (const item of pending) {
      try {
        await applySyncItemLocally(item);
        item.status = 'synced';
        item.syncedAt = Date.now();
        await idbPut(STORES.syncQueue, item);
        done++;
      } catch (err) {
        console.error('[LC Hub] Sync failed for item', item.id, err);
      }
    }

    if (done > 0) {
      showToast(`Synced ${done} offline action${done > 1 ? 's' : ''}.`);
      updateSyncBadge();
    }
    return done;
  }

  async function applySyncItemLocally(item) {
    // Demo: apply side-effects that a server would handle.
    // Registration is already written optimistically to the users store.
    switch (item.type) {
      case 'register':
        console.log('[LC Hub] Confirmed registration sync for', item.payload.email);
        break;
      case 'contact': {
        const msg = {
          id: item.payload.id || ('msg_' + Date.now()),
          ...item.payload,
          syncedAt: Date.now()
        };
        await idbPut(STORES.messages, msg);
        console.log('[LC Hub] Saved contact message from', item.payload.email);
        break;
      }
      case 'event_register':
        console.log('[LC Hub] Confirmed event registration', item.payload);
        break;
      default:
        console.log('[LC Hub] Unknown sync type', item.type);
    }
  }

  function updateSyncBadge() {
    getPendingSyncCount().then((count) => {
      let badge = document.getElementById('sync-badge');
      if (count > 0) {
        if (!badge) {
          badge = document.createElement('div');
          badge.id = 'sync-badge';
          badge.setAttribute('role', 'status');
          badge.title = 'Pending offline actions will sync when online';
          document.body.appendChild(badge);
        }
        badge.textContent = count === 1
          ? '1 action waiting to sync'
          : `${count} actions waiting to sync`;
        badge.classList.add('show');
      } else if (badge) {
        badge.classList.remove('show');
      }
    });
  }

  // ---------- Offline data persistence: drafts, preferences, activity ----------
  async function saveDraft(formId, data) {
    await idbPut(STORES.drafts, {
      formId,
      data,
      updatedAt: Date.now()
    });
  }

  async function getDraft(formId) {
    try {
      const row = await idbGet(STORES.drafts, formId);
      return row ? row.data : null;
    } catch {
      return null;
    }
  }

  async function clearDraft(formId) {
    try {
      await idbDelete(STORES.drafts, formId);
    } catch { /* ignore */ }
  }

  async function setPreference(key, value) {
    await idbPut(STORES.preferences, { key, value, updatedAt: Date.now() });
  }

  async function getPreference(key, fallback = null) {
    try {
      const row = await idbGet(STORES.preferences, key);
      return row ? row.value : fallback;
    } catch {
      return fallback;
    }
  }

  async function logActivity(type, detail) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.activity, 'readwrite');
        tx.objectStore(STORES.activity).add({
          type,
          detail: detail || '',
          at: Date.now(),
          online: navigator.onLine
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* non-critical */ }
  }

  async function persistLastPage() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    await setPreference('lastPage', page);
    await logActivity('navigate', page);
  }

  /** Auto-save form fields to IndexedDB while typing (debounced) */
  function initFormDraftPersistence(formId, formEl, fieldNames) {
    if (!formEl) return;

    let timer = null;
    const collect = () => {
      const data = {};
      fieldNames.forEach((name) => {
        const el = formEl.elements[name] || formEl.querySelector(`[name="${name}"]`);
        if (el) data[name] = el.value;
      });
      return data;
    };

    const scheduleSave = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const data = collect();
        const hasContent = Object.values(data).some((v) => String(v || '').trim());
        if (hasContent) {
          await saveDraft(formId, data);
        } else {
          await clearDraft(formId);
        }
      }, 400);
    };

    fieldNames.forEach((name) => {
      const el = formEl.elements[name] || formEl.querySelector(`[name="${name}"]`);
      if (el) {
        el.addEventListener('input', scheduleSave);
        el.addEventListener('change', scheduleSave);
      }
    });

    // Restore draft on load
    getDraft(formId).then((data) => {
      if (!data) return;
      let restored = false;
      fieldNames.forEach((name) => {
        const el = formEl.elements[name] || formEl.querySelector(`[name="${name}"]`);
        if (el && data[name] != null && data[name] !== '' && !el.value) {
          el.value = data[name];
          restored = true;
        }
      });
      if (restored) {
        showToast('Restored your saved form draft.');
        logActivity('draft_restore', formId);
      }
    });
  }

  /** Export all persistent data as JSON (backup) */
  async function exportAllData() {
    const [users, session, zoom, pending, messages, drafts, prefs, activity] = await Promise.all([
      getUsers(),
      getSession(),
      getZoomSessions(),
      getPendingSyncItems(),
      idbGetAll(STORES.messages),
      idbGetAll(STORES.drafts),
      idbGetAll(STORES.preferences),
      idbGetAll(STORES.activity)
    ]);
    return {
      exportedAt: new Date().toISOString(),
      version: DB_VERSION,
      users,
      session,
      zoomSessions: zoom,
      syncQueue: pending,
      messages,
      drafts,
      preferences: prefs,
      activity
    };
  }

  /** Import data from a previous export (merge users / replace drafts & prefs) */
  async function importAllData(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid payload');
    if (Array.isArray(payload.users) && payload.users.length) {
      for (const u of payload.users) {
        const existing = await getUserByEmail(u.email);
        if (!existing) await addUser(u);
      }
    }
    if (Array.isArray(payload.drafts)) {
      for (const d of payload.drafts) await idbPut(STORES.drafts, d);
    }
    if (Array.isArray(payload.preferences)) {
      for (const p of payload.preferences) await idbPut(STORES.preferences, p);
    }
    if (Array.isArray(payload.messages)) {
      for (const m of payload.messages) await idbPut(STORES.messages, m);
    }
    await logActivity('import', `imported at ${new Date().toISOString()}`);
    updateSyncBadge();
  }

  // ---------- Storage Persistence API (keep data under browser pressure) ----------
  async function requestPersistentStorage() {
    if (!navigator.storage || !navigator.storage.persist) {
      console.log('[LC Hub] Storage Persistence API not available');
      return { persisted: false, supported: false };
    }
    try {
      const already = await navigator.storage.persisted();
      if (already) {
        await setPreference('storagePersisted', true);
        await logActivity('storage_persist', 'already_granted');
        return { persisted: true, supported: true };
      }
      const granted = await navigator.storage.persist();
      await setPreference('storagePersisted', granted);
      await logActivity('storage_persist', granted ? 'granted' : 'denied');
      if (granted) {
        console.log('[LC Hub] Persistent storage granted – data is protected from eviction');
      } else {
        console.log('[LC Hub] Persistent storage not granted – data may be cleared under storage pressure');
      }
      return { persisted: granted, supported: true };
    } catch (err) {
      console.warn('[LC Hub] persist() failed:', err.message);
      return { persisted: false, supported: true, error: err.message };
    }
  }

  async function getStorageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return null;
    }
    try {
      const est = await navigator.storage.estimate();
      const usage = est.usage || 0;
      const quota = est.quota || 0;
      return {
        usage,
        quota,
        usageMB: +(usage / (1024 * 1024)).toFixed(2),
        quotaMB: +(quota / (1024 * 1024)).toFixed(2),
        percent: quota ? +((usage / quota) * 100).toFixed(2) : 0
      };
    } catch {
      return null;
    }
  }

  async function getPersistenceStatus() {
    const supported = !!(navigator.storage && navigator.storage.persist);
    let persisted = false;
    if (supported) {
      try {
        persisted = await navigator.storage.persisted();
      } catch { /* ignore */ }
    }
    const estimate = await getStorageEstimate();
    return { supported, persisted, estimate };
  }

  function showPersistenceIndicator(status) {
    let el = document.getElementById('persist-status');
    if (!status.supported) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'persist-status';
      el.setAttribute('role', 'status');
      el.title = 'Offline data persistence status';
      document.body.appendChild(el);
    }
    if (status.persisted) {
      el.textContent = 'Data saved offline';
      el.className = 'persist-status persist-ok show';
    } else {
      el.textContent = 'Offline storage (may be cleared)';
      el.className = 'persist-status persist-warn show';
    }
    // Auto-hide after a few seconds so it is not permanent chrome
    clearTimeout(el._hide);
    el._hide = setTimeout(() => el.classList.remove('show'), 5000);
  }

  // ---------- Migration from localStorage ----------
  async function migrateFromLocalStorage() {
    try {
      const oldUsers = JSON.parse(localStorage.getItem(LS_USERS) || '[]');
      if (oldUsers.length) {
        const existing = await getUsers();
        if (!existing.length) {
          await idbPutAll(STORES.users, oldUsers);
          console.log('[LC Hub] Migrated', oldUsers.length, 'users from localStorage → IndexedDB');
        }
        localStorage.removeItem(LS_USERS);
      }

      const oldSession = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
      if (oldSession) {
        const current = await getSession();
        if (!current) {
          await setSession(oldSession);
          console.log('[LC Hub] Migrated session from localStorage → IndexedDB');
        }
        localStorage.removeItem(LS_SESSION);
      }

      const oldZoom = JSON.parse(localStorage.getItem(LS_ZOOM) || '[]');
      if (oldZoom.length) {
        const existing = await idbGetAll(STORES.zoom);
        if (!existing.length) {
          await idbPutAll(STORES.zoom, oldZoom);
          console.log('[LC Hub] Migrated Zoom sessions from localStorage → IndexedDB');
        }
        localStorage.removeItem(LS_ZOOM);
      }
    } catch (err) {
      console.warn('[LC Hub] Migration skipped:', err.message);
    }
  }

  // ---------- Toast ----------
  function showToast(message, type = 'success') {
    let toast = document.getElementById('lc-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'lc-toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // ---------- Header / Auth UI ----------
  async function updateAuthUI() {
    const session = await getSession();
    const authGuest = document.querySelectorAll('.auth-guest');
    const authUser = document.querySelectorAll('.auth-user');
    const userNameEls = document.querySelectorAll('.user-name');
    const userInitialEls = document.querySelectorAll('.user-initial');

    if (session) {
      authGuest.forEach(el => { el.style.display = 'none'; });
      authUser.forEach(el => { el.style.display = ''; });
      userNameEls.forEach(el => { el.textContent = session.name.split(' ')[0]; });
      userInitialEls.forEach(el => {
        el.textContent = (session.name || 'U').charAt(0).toUpperCase();
      });
    } else {
      authGuest.forEach(el => { el.style.display = ''; });
      authUser.forEach(el => { el.style.display = 'none'; });
    }
  }

  // ---------- Mobile menu ----------
  function initMobileMenu() {
    const toggle = document.querySelector('.menu-toggle');
    const mobileMenu = document.querySelector('.mobile-menu');
    if (!toggle || !mobileMenu) return;

    toggle.addEventListener('click', () => {
      toggle.classList.toggle('active');
      mobileMenu.classList.toggle('open');
    });

    mobileMenu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        toggle.classList.remove('active');
        mobileMenu.classList.remove('open');
      });
    });
  }

  // ---------- Active nav link ----------
  function setActiveNav() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link').forEach(link => {
      const href = link.getAttribute('href');
      if (href === path || (path === '' && href === 'index.html')) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  // ---------- Search ----------
  function initSearch() {
    const inputs = document.querySelectorAll('.search-input');
    inputs.forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const q = input.value.trim().toLowerCase();
          if (!q) return;
          const map = {
            home: 'index.html',
            about: 'about.html',
            event: 'events.html',
            events: 'events.html',
            learn: 'learn.html',
            zoom: 'learn.html',
            research: 'research.html',
            innovate: 'innovate.html',
            impact: 'impact.html',
            contact: 'contact.html',
            register: 'register.html',
            login: 'login.html',
            signup: 'register.html'
          };
          for (const [key, page] of Object.entries(map)) {
            if (q.includes(key)) {
              window.location.href = page;
              return;
            }
          }
          showToast('No matching page found. Try: home, about, learn, events...', 'error');
        }
      });
    });
  }

  // ---------- User dropdown ----------
  function initUserDropdown() {
    document.querySelectorAll('.user-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const dropdown = btn.nextElementSibling;
        document.querySelectorAll('.user-dropdown').forEach(d => {
          if (d !== dropdown) d.classList.remove('show');
        });
        dropdown.classList.toggle('show');
      });
    });
    document.addEventListener('click', () => {
      document.querySelectorAll('.user-dropdown').forEach(d => d.classList.remove('show'));
    });
  }

  // ---------- Logout ----------
  function initLogout() {
    document.querySelectorAll('.logout-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        await setSession(null);
        await updateAuthUI();
        showToast('You have been logged out.');
        renderZoomSessions();
      });
    });
  }

  // ---------- Registration ----------
  function initRegisterForm() {
    const form = document.getElementById('register-form');
    if (!form) return;

    // Persist non-sensitive fields offline (not passwords)
    initFormDraftPersistence('register', form, ['name', 'email', 'role']);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);

      const name = form.name.value.trim();
      const email = form.email.value.trim().toLowerCase();
      const password = form.password.value;
      const confirm = form.confirm.value;
      const role = form.role ? form.role.value : 'learner';

      let valid = true;
      if (name.length < 2) {
        showError(form.name, 'Please enter your full name');
        valid = false;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showError(form.email, 'Please enter a valid email');
        valid = false;
      }
      if (password.length < 6) {
        showError(form.password, 'Password must be at least 6 characters');
        valid = false;
      }
      if (password !== confirm) {
        showError(form.confirm, 'Passwords do not match');
        valid = false;
      }
      if (!valid) return;

      try {
        const existing = await getUserByEmail(email);
        if (existing) {
          showAlert(form, 'This email is already registered. Please login.', 'error');
          return;
        }

        const user = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          name,
          email,
          password, // demo only
          role,
          createdAt: new Date().toISOString()
        };

        // Optimistic write – works offline and persists in IndexedDB
        await addUser(user);
        await setSession(user);
        await updateAuthUI();
        await clearDraft('register');
        await logActivity('register', user.email);

        await enqueueSync('register', {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt
        });

        if (navigator.onLine) {
          showAlert(form, 'Registration successful! Welcome to LC Hub.', 'success');
        } else {
          showAlert(form, 'Registered offline. Data saved locally and will sync when online.', 'success');
        }

        form.reset();
        setTimeout(() => { window.location.href = 'index.html'; }, 1500);
      } catch (err) {
        console.error(err);
        showAlert(form, 'Registration failed. Please try again.', 'error');
      }
    });
  }

  // ---------- Login ----------
  function initLoginForm() {
    const form = document.getElementById('login-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clearErrors(form);

      const email = form.email.value.trim().toLowerCase();
      const password = form.password.value;

      let valid = true;
      if (!email) {
        showError(form.email, 'Email is required');
        valid = false;
      }
      if (!password) {
        showError(form.password, 'Password is required');
        valid = false;
      }
      if (!valid) return;

      try {
        const user = await getUserByEmail(email);
        if (!user || user.password !== password) {
          showAlert(form, 'Invalid email or password.', 'error');
          return;
        }

        await setSession(user);
        await updateAuthUI();
        showAlert(form, 'Login successful! Redirecting...', 'success');
        setTimeout(() => { window.location.href = 'index.html'; }, 1200);
      } catch (err) {
        console.error(err);
        showAlert(form, 'Login failed. Please try again.', 'error');
      }
    });
  }

  function showError(input, msg) {
    const group = input.closest('.form-group');
    if (group) {
      group.classList.add('has-error');
      const err = group.querySelector('.error');
      if (err) err.textContent = msg;
    }
  }

  function clearErrors(form) {
    form.querySelectorAll('.form-group').forEach(g => g.classList.remove('has-error'));
    const alert = form.querySelector('.alert');
    if (alert) {
      alert.classList.remove('show', 'alert-success', 'alert-error');
      alert.textContent = '';
    }
  }

  function showAlert(form, msg, type) {
    const alert = form.querySelector('.alert');
    if (alert) {
      alert.textContent = msg;
      alert.className = `alert alert-${type} show`;
    }
  }

  // ---------- Render Zoom sessions ----------
  async function renderZoomSessions() {
    const container = document.getElementById('zoom-sessions');
    if (!container) return;

    const sessions = (await getZoomSessions()).sort((a, b) => a.date.localeCompare(b.date));
    const session = await getSession();

    if (sessions.length === 0) {
      container.innerHTML = '<p style="text-align:center;color:var(--gray-500)">No upcoming sessions.</p>';
      return;
    }

    container.innerHTML = sessions.map(s => {
      const d = new Date(s.date + 'T00:00:00');
      const day = d.getDate();
      const month = d.toLocaleString('en', { month: 'short' });
      const weekday = d.toLocaleString('en', { weekday: 'long' });

      return `
        <div class="session-card">
          <div class="session-date">
            <div class="day">${day}</div>
            <div class="month">${month}</div>
          </div>
          <div class="session-info" style="flex:1">
            <h3>${escapeHtml(s.title)}</h3>
            <div class="session-meta">
              <span>
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                ${weekday} · ${s.time} · ${s.duration}
              </span>
              <span>
                <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                ${escapeHtml(s.host)}
              </span>
            </div>
            <p style="font-size:0.9rem;color:var(--gray-500);margin-bottom:0.75rem">${escapeHtml(s.description)}</p>
            <div class="session-actions">
              ${session
                ? `<a href="${s.zoomLink}" target="_blank" rel="noopener" class="btn btn-primary">
                     Join Zoom Meeting
                   </a>
                   <span style="font-size:0.8rem;color:var(--gray-500);align-self:center">ID: ${s.meetingId}</span>`
                : `<a href="login.html" class="btn btn-outline">Login to join Zoom</a>`
              }
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Contact form (queues when offline + draft persistence) ----------
  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;

    // Field names match contact.html (name/cname, email/cemail, subject, message)
    const draftFields = [];
    ['name', 'cname', 'email', 'cemail', 'subject', 'message'].forEach((n) => {
      if (form.elements[n] || form.querySelector(`[name="${n}"]`)) draftFields.push(n);
    });
    initFormDraftPersistence('contact', form, draftFields.length ? draftFields : ['name', 'email', 'subject', 'message']);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const name = (form.name?.value || form.cname?.value || '').trim();
      const email = (form.email?.value || form.cemail?.value || '').trim();
      const subject = (form.subject?.value || '').trim();
      const message = (form.message?.value || '').trim();

      if (!name || !email || !message) {
        showToast('Please fill in name, email and message.', 'error');
        return;
      }

      const payload = {
        id: 'msg_' + Date.now().toString(36),
        name,
        email,
        subject,
        message,
        createdAt: new Date().toISOString()
      };

      try {
        if (navigator.onLine) {
          await idbPut(STORES.messages, { ...payload, syncedAt: Date.now() });
          showToast('Message sent! We will get back to you soon.');
        } else {
          await enqueueSync('contact', payload);
          showToast('Message saved offline. It will send when you are back online.');
        }
        await clearDraft('contact');
        await logActivity('contact', email);
        form.reset();
      } catch (err) {
        console.error(err);
        showToast('Could not save message. Please try again.', 'error');
      }
    });
  }

  // ---------- Offline mode / Service Worker ----------
  function initOfflineMode() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('[LC Hub] Service Worker registered', reg.scope);
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                showToast('Update available – reload to get the latest version.');
              }
            });
          });
        })
        .catch((err) => {
          console.warn('[LC Hub] SW registration failed (normal on file://)', err.message);
        });

      // Listen for sync-complete messages from the Service Worker
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SYNC_COMPLETE') {
          const n = event.data.count || 0;
          if (n > 0) {
            showToast(`Synced ${n} offline action${n > 1 ? 's' : ''}.`);
            updateSyncBadge();
          }
        }
      });
    }

    updateOnlineStatus();
    updateSyncBadge();

    window.addEventListener('online', async () => {
      updateOnlineStatus();
      showToast('Back online – syncing offline actions…');
      // Fallback processing if Background Sync API is unavailable
      await processSyncQueueLocally();
      // Also ask SW to process
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'PROCESS_SYNC' });
      }
      await requestBackgroundSync();
    });

    window.addEventListener('offline', () => {
      updateOnlineStatus();
      showToast('You are offline. Actions will sync later.', 'error');
    });
  }

  function updateOnlineStatus() {
    let banner = document.getElementById('offline-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offline-banner';
      banner.setAttribute('role', 'status');
      banner.innerHTML = `
        <span class="offline-banner-text">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0119 12.55M5 12.55a10.94 10.94 0 015.17-2.39M10.71 5.05A16 16 0 0122.58 9M1.42 9a15.91 15.91 0 014.7-2.88M8.53 16.11a6 6 0 016.95 0M12 20h.01"/>
          </svg>
          You’re offline — showing cached content
        </span>
      `;
      document.body.prepend(banner);
    }

    if (navigator.onLine) {
      banner.classList.remove('show');
    } else {
      banner.classList.add('show');
    }
  }

  // ---------- Debug / persistence helpers ----------
  window.LCHubDB = {
    getUsers,
    getSession,
    getZoomSessions,
    getPendingSyncItems,
    getPendingSyncCount,
    processSyncQueueLocally,
    enqueueSync,
    saveDraft,
    getDraft,
    clearDraft,
    setPreference,
    getPreference,
    exportAllData,
    importAllData,
    requestPersistentStorage,
    getStorageEstimate,
    getPersistenceStatus,
    async clearAll() {
      await idbClear(STORES.users);
      await idbClear(STORES.session);
      await idbClear(STORES.zoom);
      await idbClear(STORES.syncQueue);
      await idbClear(STORES.messages);
      await idbClear(STORES.drafts);
      await idbClear(STORES.preferences);
      await idbClear(STORES.activity);
      updateSyncBadge();
      console.log('[LC Hub] IndexedDB cleared');
    },
    async stats() {
      const users = await getUsers();
      const session = await getSession();
      const zoom = await getZoomSessions();
      const pending = await getPendingSyncCount();
      const messages = await idbGetAll(STORES.messages);
      const drafts = await idbGetAll(STORES.drafts);
      const prefs = await idbGetAll(STORES.preferences);
      const activity = await idbGetAll(STORES.activity);
      const persistence = await getPersistenceStatus();
      console.table({
        users: users.length,
        session: !!session,
        zoomSessions: zoom.length,
        pendingSync: pending,
        messages: messages.length,
        drafts: drafts.length,
        preferences: prefs.length,
        activity: activity.length,
        storagePersisted: persistence.persisted,
        usageMB: persistence.estimate ? persistence.estimate.usageMB : 'n/a'
      });
      return { users, session, zoom, pending, messages, drafts, prefs, activity, persistence };
    },
    async downloadBackup() {
      const data = await exportAllData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lc-hub-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Backup downloaded.');
    }
  };

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await openDB();
      await migrateFromLocalStorage();
      await persistLastPage();
      await logActivity('app_start', navigator.onLine ? 'online' : 'offline');

      // Request durable offline storage (best-effort)
      const persistResult = await requestPersistentStorage();
      const status = await getPersistenceStatus();
      showPersistenceIndicator(status);
      if (persistResult.supported && persistResult.persisted) {
        console.log('[LC Hub] Offline data persistence active');
      }
    } catch (err) {
      console.warn('[LC Hub] IndexedDB unavailable, features limited:', err.message);
    }

    await updateAuthUI();
    initMobileMenu();
    setActiveNav();
    initSearch();
    initUserDropdown();
    initLogout();
    initRegisterForm();
    initLoginForm();
    await renderZoomSessions();
    initContactForm();
    initOfflineMode();
  });
})();
