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
  const POLL_MS = 15000;

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
  };
  const COLLECTIONS = ['invoices', 'cashRecs', 'tsPushes'];
  const SINGLETONS  = ['settings', 'tsAdjustments', 'staff', 'supplierFingerprints'];

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

  async function post(payload) {
    if (!available || CONFIG.FEATURES.DEMO_MODE) return false;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 503) { available = false; return false; }
      return res.ok;
    } catch { return false; }
  }

  // Mirror one collection item (invoice / cash rec / ts push) to the server.
  function pushItem(coll, item) {
    if (!COLLECTIONS.includes(coll) || !item?.id) return;
    post({ op: 'putItem', coll, id: item.id, value: item });
  }

  // Mirror a whole singleton (settings / tsAdjustments / staff / fingerprints /
  // tombstones) to the server.
  function pushKey(key, value) {
    if (!(SINGLETONS.includes(key) || key === 'tombstones') || value == null) return;
    post({ op: 'putKey', key, value });
  }

  // Delete a collection item on the server (HDEL). The id is also tombstoned
  // locally by Store so it isn't re-created on the next merge.
  function delItem(coll, id) {
    if (!COLLECTIONS.includes(coll) || !id) return;
    post({ op: 'delItem', coll, id });
  }

  // Pull the shared snapshot and merge it into localStorage.
  async function pull() {
    if (CONFIG.FEATURES.DEMO_MODE || !available) return;
    let snap;
    try {
      const res = await fetch(API, { method: 'GET' });
      if (res.status === 503) { available = false; setConnected(false); return; }
      if (!res.ok) { setConnected(false); return; }
      snap = await res.json();
      setConnected(true);
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
    // yet, seed it from this device's local copy.
    for (const key of SINGLETONS) {
      const serverVal = snap[key];
      if (serverVal != null) {
        const next = JSON.stringify(serverVal);
        if (localStorage.getItem(LS[key]) !== next) { localStorage.setItem(LS[key], next); changed = true; }
      } else {
        const localRaw = localStorage.getItem(LS[key]);
        if (localRaw) { try { pushKey(key, JSON.parse(localRaw)); } catch {} }
      }
    }

    if (changed && window.App && typeof App.onDataChanged === 'function') {
      App.onDataChanged();
    }
  }

  async function init() {
    if (CONFIG.FEATURES.DEMO_MODE) return;
    await pull();
    if (timer) clearInterval(timer);
    timer = setInterval(pull, POLL_MS);
    // Pull immediately when the app regains focus for a snappier feel.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pull();
    });
  }

  return { init, pull, pushItem, pushKey, delItem, isConnected: () => connected === true };

})();
