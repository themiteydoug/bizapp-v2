/**
 * PCW · Sync
 * Keeps each device's localStorage in step with the shared KV store (/api/data)
 * so data entered on one device appears on the others — live monitoring.
 *
 * Design:
 *  - localStorage stays the fast local cache; the UI keeps reading it synchronously.
 *  - Writes (Store.save*) call Sync.pushItem / Sync.pushKey to mirror to the server.
 *  - A poller pulls the shared snapshot every POLL_MS (and on focus), merges it
 *    into localStorage, and asks the app to re-render if anything changed.
 *  - If the server isn't configured/reachable, everything still works locally.
 *
 * Not synced: Xero tokens (per-device OAuth) and the PIN session.
 */

const Sync = (() => {

  const API     = '/api/data';
  // Poll cadence for the shared snapshot. Only runs while the app is on-screen
  // (see init) — a backgrounded PWA polling around the clock was the biggest
  // consumer of the Vercel data allowance.
  const POLL_MS = 30000;

  // server snapshot key → localStorage key
  const LS = {
    invoices:             'bizops_invoices',
    cashRecs:             'bizops_cash_recs',
    tsPushes:             'bizops_ts_pushes',
    settings:             'bizops_settings',
    tsAdjustments:        'bizops_ts_adjustments',
    staff:                'bizops_staff',
    supplierFingerprints: 'bizops_supplier_fp',
    tombstones:           'bizops_tombstones',
    cleanJobs:            'bizops_clean_jobs',
    cleanLog:             'bizops_clean_log',
  };
  const COLLECTIONS = ['invoices', 'cashRecs', 'tsPushes', 'cleanLog'];
  const SINGLETONS  = ['settings', 'tsAdjustments', 'staff', 'supplierFingerprints', 'cleanJobs'];

  let timer = null;
  let available = true;   // flips false if the server says it's not configured
  let connected = null;   // last network op result (drives the header indicator)

  function setConnected(v) {
    if (v !== connected) {
      connected = v;
      if (window.App && typeof App.onSyncStatus === 'function') App.onSyncStatus(v);
    }
  }

  function sortColl(coll, arr) {
    const ts = it => it.createdAt || it.pushedAt || it.date || '';
    return arr.slice().sort((a, b) => String(ts(b)).localeCompare(String(ts(a))));
  }

  // ── Outbox: writes the server hasn't accepted yet ──────────────────────
  // Every write used to be fire-and-forget, so a refused or dropped one was
  // gone: eight days of invoices were entered during the domain move and never
  // left the devices they were typed on, while the header still said "Synced".
  // Failed writes now stay here, are retried on every tick, and are counted in
  // the header so a backlog can never be invisible again.
  const outbox = new Map();   // descriptor → payload (re-queuing replaces)

  const outboxKey = p =>
      p.op === 'putItem' || p.op === 'delItem' ? `${p.op}:${p.coll}:${p.id}`
    : p.op === 'putKey'                        ? `putKey:${p.key}`
    :                                            `${p.op}:${p.id || ''}`;

  // Singletons with a local edit the server hasn't confirmed. Persisted, because
  // an in-memory set is wiped by a reload — and the pull below overwrites local
  // singletons from the server, so an unsynced staff or timesheet edit was
  // silently destroyed the next time the app opened.
  const DIRTY_LS = 'bizops_sync_dirty';
  const dirtyKeys = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(DIRTY_LS) || '[]')); }
    catch { return new Set(); }
  })();
  const saveDirty  = () => { try { localStorage.setItem(DIRTY_LS, JSON.stringify([...dirtyKeys])); } catch {} };
  const markDirty  = k => { if (!dirtyKeys.has(k)) { dirtyKeys.add(k); saveDirty(); } };
  const clearDirty = k => { if (dirtyKeys.delete(k)) saveDirty(); };

  // One count for "things this device still owes the server".
  function pendingCount() {
    const all = new Set(outbox.keys());
    for (const k of dirtyKeys) all.add('putKey:' + k);
    return all.size;
  }
  function reportPending() {
    if (window.App && typeof App.onSyncPending === 'function') App.onSyncPending(pendingCount());
  }

  async function post(payload) {
    if (!available || CONFIG.FEATURES.DEMO_MODE) return false;
    const key = outboxKey(payload);
    let ok = false;
    let retryable = true;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 503) { available = false; return false; }
      // A rejected write used to return quietly, so a device that could still
      // READ looked perfectly synced while nothing it entered ever left it.
      // Anything that isn't an OK now shows in the header and the console.
      if (res.ok) {
        ok = true;
        setConnected(true);
      } else {
        console.warn(`[sync] write refused: ${res.status} ${payload.op || ''}`);
        // 400 is a malformed payload: the server will never accept it, and
        // re-sending it every 30 seconds would wedge the queue behind it and
        // hold the header at "1 to sync" forever. Everything else (403 while a
        // domain setting is wrong, 5xx, a dropped connection) is worth retrying.
        retryable = res.status !== 400;
        setConnected(false);
      }
    } catch {
      setConnected(false);
    }
    if (ok || !retryable) outbox.delete(key); else outbox.set(key, payload);
    reportPending();
    return ok;
  }

  // Re-send the backlog. Runs every tick, deliberately outside the revision
  // check below: a device that was offline when it saved must not sit on its
  // backlog until some other device happens to write something.
  async function flush() {
    if (!outbox.size || !available || CONFIG.FEATURES.DEMO_MODE) return;
    for (const payload of [...outbox.values()]) {
      if (!(await post(payload))) return;   // still down — try again next tick
    }
  }

  // Mirror one collection item (invoice / cash rec / ts push) to the server.
  function pushItem(coll, item) {
    if (!COLLECTIONS.includes(coll) || !item?.id) return;
    post({ op: 'putItem', coll, id: item.id, value: item });
  }

  // Mirror a whole singleton (settings / tsAdjustments / staff / fingerprints /
  // tombstones) to the server. While a key is dirty a pull must NOT overwrite
  // the local copy — that would wipe a fresh edit, e.g. a manager's timesheet
  // hour change.
  function pushKey(key, value) {
    if (!(SINGLETONS.includes(key) || key === 'tombstones') || value == null) return;
    markDirty(key);
    const sent = JSON.stringify(value);
    post({ op: 'putKey', key, value }).then(ok => {
      // Only clear dirty if no newer local edit happened while this was in flight.
      if (ok && localStorage.getItem(LS[key]) === sent) { clearDirty(key); reportPending(); }
    });
  }

  // Delete a collection item on the server (HDEL). The id is also tombstoned
  // locally by Store so it isn't re-created on the next merge.
  function delItem(coll, id) {
    if (!COLLECTIONS.includes(coll) || !id) return;
    post({ op: 'delItem', coll, id });
  }

  // ── Invoice photos (stored server-side, never in localStorage/snapshot) ──
  const photoCache = new Map();   // session cache so re-opening doesn't refetch

  async function putPhoto(id, dataUrl) {
    if (!id || !dataUrl) return false;
    photoCache.set(id, dataUrl);
    return post({ op: 'putPhoto', id, value: dataUrl });
  }

  function delPhoto(id) {
    if (!id) return;
    photoCache.delete(id);
    post({ op: 'delPhoto', id });
  }

  async function getPhoto(id) {
    if (!id) return null;
    if (photoCache.has(id)) return photoCache.get(id);
    try {
      const res = await fetch(`${API}?photo=${encodeURIComponent(id)}`, { method: 'GET' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.dataUrl) photoCache.set(id, data.dataUrl);
      return data.dataUrl || null;
    } catch { return null; }
  }

  // Pull the shared snapshot and merge it into localStorage.
  // The revision we last pulled. null means "never pulled", so the first poll
  // always fetches the snapshot in full.
  let lastRev = null;

  // Ask the server whether anything has changed — a couple of dozen bytes,
  // against a snapshot that carries every invoice and cash count ever entered
  // and grows every week. Polling the snapshot itself was burning through the
  // hosting data allowance for no benefit; nothing changes most ticks.
  // Returns true when a full pull is warranted.
  async function revChanged() {
    if (lastRev === null) return true;
    try {
      const res = await fetch(`${API}?rev=1`, { method: 'GET', cache: 'no-store' });
      if (res.status === 503) { available = false; setConnected(false); return false; }
      if (!res.ok) return true;              // can't tell — fall back to a full pull
      const { rev } = await res.json();
      setConnected(true);
      return rev !== lastRev;
    } catch {
      setConnected(false);
      return false;
    }
  }

  async function pull() {
    if (CONFIG.FEATURES.DEMO_MODE || !available) return;
    await flush();                        // clear any backlog before reading
    if (!(await revChanged())) return;
    let snap;
    try {
      const res = await fetch(API, { method: 'GET' });
      if (res.status === 503) { available = false; setConnected(false); return; }
      if (!res.ok) { setConnected(false); return; }
      snap = await res.json();
      setConnected(true);
      // Only advance once the snapshot is actually in hand, so a failed pull
      // is retried rather than silently skipped.
      if (typeof snap.rev === 'number') lastRev = snap.rev;
    } catch { setConnected(false); return; }

    let changed = false;

    // Tombstones (deleted ids): union local + server so a deletion on any device
    // is honoured everywhere and never resurrected.
    const serverTomb = Array.isArray(snap.tombstones) ? snap.tombstones : [];
    const localTomb  = JSON.parse(localStorage.getItem(LS.tombstones) || '[]');
    const tomb       = Array.from(new Set([...localTomb, ...serverTomb]));
    const tombSet    = new Set(tomb);
    if (JSON.stringify(tomb) !== JSON.stringify(localTomb)) {
      localStorage.setItem(LS.tombstones, JSON.stringify(tomb));
    }
    if (tomb.length > serverTomb.length) pushKey('tombstones', tomb);   // seed server

    // Collections: union by id (server wins per id; keep local-only items and
    // re-push them so a failed write self-heals). Tombstoned ids are dropped
    // and never re-created.
    for (const coll of COLLECTIONS) {
      if (!Array.isArray(snap[coll])) continue;
      const local = JSON.parse(localStorage.getItem(LS[coll]) || '[]');
      const byId = new Map();
      for (const it of snap[coll]) if (it?.id && !tombSet.has(it.id)) byId.set(it.id, it);
      const localOnly = [];
      for (const it of local) {
        if (it?.id && !byId.has(it.id) && !tombSet.has(it.id)) { byId.set(it.id, it); localOnly.push(it); }
      }
      const merged = sortColl(coll, [...byId.values()]);
      const next = JSON.stringify(merged);
      if (localStorage.getItem(LS[coll]) !== next) { localStorage.setItem(LS[coll], next); changed = true; }
      // Seed the server with anything it didn't have yet (first run / failed push)
      for (const it of localOnly) pushItem(coll, it);
    }

    // Singletons: server overwrites local when present; if the server has none
    // yet, seed it from this device's local copy. A locally-edited (dirty) key is
    // never overwritten — we keep the local value and re-push until confirmed, so
    // unsynced edits (e.g. timesheet adjustments) are never lost.
    for (const key of SINGLETONS) {
      const localRaw  = localStorage.getItem(LS[key]);
      const serverRaw = snap[key] != null ? JSON.stringify(snap[key]) : null;

      if (dirtyKeys.has(key)) {
        // Already up there (a push landed, or another device sent the same
        // thing) — stop claiming local is authoritative for this key.
        if (serverRaw !== null && localRaw === serverRaw) { clearDirty(key); reportPending(); continue; }
        if (localRaw) { try { pushKey(key, JSON.parse(localRaw)); } catch {} }
        continue;
      }
      if (serverRaw !== null) {
        if (localRaw !== serverRaw) { localStorage.setItem(LS[key], serverRaw); changed = true; }
      } else if (localRaw) {
        try { pushKey(key, JSON.parse(localRaw)); } catch {}
      }
    }

    if (changed && window.App && typeof App.onDataChanged === 'function') {
      App.onDataChanged();
    }
  }

  // Force a full snapshot pull, ignoring the revision check. The pull's merge is
  // what re-pushes collection items the server is missing, so this is the only
  // thing that rescues data stranded by an earlier failed write — a device that
  // was only ever *resumed* (a PWA coming back from the background never
  // reloads) would otherwise take the cheap revision path forever and never
  // notice it was holding a week of invoices nobody else could see.
  async function resync() {
    lastRev = null;
    available = true;           // give a device that gave up another chance
    await pull();
    return pendingCount();
  }

  async function init() {
    if (CONFIG.FEATURES.DEMO_MODE) return;
    reportPending();        // a dirty key survived the reload — say so at once
    await pull();
    if (timer) clearInterval(timer);
    // Only poll while the app is actually visible — don't keep pulling from a
    // device sitting backgrounded in someone's pocket.
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') pull();
    }, POLL_MS);
    // Pull immediately when the app regains focus for a snappier feel.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pull();
    });
  }

  return { init, pull, flush, resync, pushItem, pushKey, delItem, putPhoto, getPhoto, delPhoto,
           pendingCount, isConnected: () => connected === true };

})();

// `const` at top level does NOT attach to window in classic scripts; other
// modules reference `window.Sync`, so expose it explicitly.
window.Sync = Sync;
