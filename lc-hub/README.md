# LC Hub – Offline-Ready PWA

Multi-page responsive site with **IndexedDB persistence**, **Service Worker offline**, **Background Sync**, form **drafts**, and the **Storage Persistence API**.

## Quick start

```bash
cd lc-hub
python3 -m http.server 8080
```

Open **http://localhost:8080** (HTTP required for Service Worker).

## Offline data persistence

Everything critical is stored in **IndexedDB** (`LCHubDB`) so it survives reloads, browser restarts, and offline use.

| Store | What is persisted |
|-------|-------------------|
| `users` | Registered accounts |
| `session` | Logged-in user |
| `zoomSessions` | Learn schedule |
| `syncQueue` | Offline actions waiting to sync |
| `messages` | Contact form submissions |
| `drafts` | In-progress form text (register, contact) |
| `preferences` | Last page, storage flags |
| `activity` | Audit log (navigate, sync, persist events) |

### Layers of protection

1. **IndexedDB** – primary durable store (async, large capacity)
2. **Form drafts** – auto-saved while typing; restored on return
3. **Background Sync** – offline register/contact flushed when online
4. **Service Worker cache** – pages/CSS/JS available offline
5. **Storage Persistence API** – asks the browser not to evict site data under disk pressure

### Form drafts

- **Register** and **Contact** fields are debounced and saved to `drafts`
- Refreshing or reopening the page restores the draft
- Successful submit clears the draft

### Storage Persistence API

On load the app calls `navigator.storage.persist()`. If granted:

- A short green badge shows: **“Data saved offline”**
- Site data is less likely to be cleared when the device is low on space

If not granted (or unsupported), a brief amber note appears instead.

### Backup / restore

```js
await LCHubDB.downloadBackup()     // download JSON backup
const data = await LCHubDB.exportAllData()
await LCHubDB.importAllData(data)  // merge users, restore drafts/prefs/messages

await LCHubDB.getPersistenceStatus()
await LCHubDB.getStorageEstimate()
await LCHubDB.requestPersistentStorage()
await LCHubDB.stats()
```

## Background Sync

Offline **registration** and **contact** submissions are queued in `syncQueue` and processed when connectivity returns (Background Sync API or `online` event fallback).

## Offline mode

| Feature | Behaviour |
|---------|-----------|
| Service Worker | Caches all pages, CSS, JS |
| Offline banner | Amber bar when offline |
| Sync badge | Shows pending queue count |
| Fallback page | `offline.html` for uncached routes |

## Structure

```
lc-hub/
├── *.html + offline.html
├── css/style.css
├── js/app.js       ← IndexedDB, drafts, persist API, sync, UI
├── sw.js           ← Cache + Background Sync
├── manifest.json
└── README.md
```

## Notes

- Passwords are plain text for demo only.
- Zoom links are placeholders.
- Bump `CACHE_VERSION` in `sw.js` when deploying asset changes.
- Persistence works best on **HTTPS** or **localhost** with a Chromium-based browser.
