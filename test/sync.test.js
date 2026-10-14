/**
 * Regression tests for js/sync.js — the paths that lost data during the
 * domain move.
 *
 * Three defects are covered:
 *   A. An unsynced singleton edit (staff, timesheet adjustments, cleaning jobs)
 *      was overwritten by the server copy on the next app open, because the
 *      "dirty" marker lived only in memory and a reload wiped it.
 *   B. A failed write was only retried inside a full pull, and a full pull only
 *      happens when the revision changes — so a device that was offline when it
 *      saved sat on its backlog until some *other* device wrote something.
 *   C. The header said "Synced" with unsent writes queued, which is how eight
 *      days of invoices went missing without anyone noticing.
 *
 * Run: node test/sync.test.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// ── Harness ────────────────────────────────────────────────────────────────
// A fake localStorage that can be carried across "reloads", and a scripted
// fetch so each test can decide what the server does.
function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _map: map,
  };
}

/** Boot sync.js against the given localStorage + fetch. Returns { Sync, calls, pending }. */
function boot(localStorage, fetchImpl) {
  const calls   = [];                 // every POST body the module sent
  const pending = [];                 // every App.onSyncPending(n) value
  const sandbox = {
    localStorage,
    console: { warn() {}, log() {} },
    CONFIG: { FEATURES: { DEMO_MODE: false } },
    setInterval: () => 0,
    clearInterval: () => {},
    document: { addEventListener() {}, visibilityState: 'visible' },
    JSON, Map, Set, Number, String, Array, Object, Promise,
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') calls.push(JSON.parse(opts.body));
      return fetchImpl(url, opts);
    },
  };
  sandbox.window = sandbox;
  sandbox.App = { onSyncPending: n => pending.push(n), onSyncStatus() {}, onDataChanged() {} };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { Sync: sandbox.Sync, calls, pending, sandbox };
}

// pendingCount() did not exist before this fix — report that rather than
// crashing the whole suite on an older revision.
const pendingOf = Sync => (typeof Sync.pendingCount === 'function' ? Sync.pendingCount() : 'no pendingCount()');
const flushOf   = Sync => (typeof Sync.flush === 'function' ? Sync.flush() : Promise.resolve());

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const LS_STAFF = 'bizops_staff';
const DIRTY    = 'bizops_sync_dirty';

// ── A. An unsynced singleton edit survives a reload and is not clobbered ──
async function testDirtySurvivesReload() {
  console.log('A. unsynced singleton edit survives a reload');

  const localEdit  = [{ id: 's1', name: 'Lia', rate: 32 }];      // typed on this device
  const serverCopy = [{ id: 's1', name: 'Lia', rate: 28 }];      // stale copy up there

  // Session 1: the edit is saved while the server is refusing writes (403,
  // exactly what the wrong APP_ORIGIN did).
  const ls = makeStore({ [LS_STAFF]: JSON.stringify(localEdit) });
  const s1 = boot(ls, async () => json({ error: 'Forbidden' }, 403));
  s1.Sync.pushKey('staff', localEdit);
  await new Promise(r => setImmediate(r));

  check('dirty marker is persisted, not just in memory',
    JSON.parse(ls.getItem(DIRTY) || '[]').includes('staff'),
    `bizops_sync_dirty = ${ls.getItem(DIRTY)}`);

  // Session 2: the app is reopened. The server is reachable again and hands
  // back its stale copy.
  const s2 = boot(ls, async (url, opts) => {
    if (opts && opts.method === 'POST') return json({ ok: true, rev: 2 });
    if (String(url).includes('rev=1')) return json({ rev: 1 });
    return json({ rev: 1, invoices: [], cashRecs: [], tsPushes: [], cleanLog: [], staff: serverCopy });
  });
  await s2.Sync.pull();
  await new Promise(r => setImmediate(r));

  check('local edit is NOT overwritten by the stale server copy',
    JSON.parse(ls.getItem(LS_STAFF))[0].rate === 32,
    `rate is now ${JSON.parse(ls.getItem(LS_STAFF))[0].rate}, expected 32`);

  check('the edit is pushed up instead',
    s2.calls.some(c => c.op === 'putKey' && c.key === 'staff' && c.value[0].rate === 32),
    `sent: ${JSON.stringify(s2.calls.map(c => c.op + ':' + (c.key || c.id)))}`);

  check('dirty marker clears once the server agrees',
    !JSON.parse(ls.getItem(DIRTY) || '[]').includes('staff'),
    `bizops_sync_dirty = ${ls.getItem(DIRTY)}`);
}

// ── B. A failed write is retried without waiting for someone else to write ──
async function testBacklogRetriedWithoutRevChange() {
  console.log('B. backlog is retried even when the revision has not moved');

  const ls = makeStore({});
  let online = false;
  const { Sync, calls } = boot(ls, async (url, opts) => {
    if (opts && opts.method === 'POST') return online ? json({ ok: true, rev: 5 }) : json({}, 502);
    if (String(url).includes('rev=1')) return json({ rev: 5 });
    return json({ rev: 5, invoices: [], cashRecs: [], tsPushes: [], cleanLog: [] });
  });

  // First pull establishes the revision, so later pulls take the cheap path.
  await Sync.pull();

  // Save an invoice while the network is down.
  Sync.pushItem('invoices', { id: 'inv_1', subtotal: 100 });
  await new Promise(r => setImmediate(r));
  check('a refused write is counted as outstanding',
    pendingOf(Sync) === 1, `pendingCount() = ${pendingOf(Sync)}`);

  // Count from HERE, so the failed attempt itself can't be mistaken for the
  // retry — that false pass hid the bug the first time this test was written.
  const beforeRetry = calls.length;

  // Network recovers. Nothing else has written, so the revision is unchanged —
  // the only thing that can rescue this invoice is the retry.
  online = true;
  await Sync.pull();
  await new Promise(r => setImmediate(r));

  check('the invoice is re-sent on the next tick',
    calls.slice(beforeRetry).some(c => c.op === 'putItem' && c.id === 'inv_1'),
    `POSTs after the network came back: ${JSON.stringify(calls.slice(beforeRetry))}`);
  check('nothing is left outstanding',
    pendingOf(Sync) === 0, `pendingCount() = ${pendingOf(Sync)}`);
}

// ── C. The header is told about the backlog ────────────────────────────────
async function testHeaderReportsBacklog() {
  console.log('C. the backlog reaches the header');

  const ls = makeStore({});
  let online = false;
  const { Sync, pending } = boot(ls, async (url, opts) => {
    if (opts && opts.method === 'POST') return online ? json({ ok: true }) : json({}, 403);
    return json({ rev: 1, invoices: [], cashRecs: [], tsPushes: [], cleanLog: [] });
  });

  Sync.pushItem('invoices', { id: 'inv_a', subtotal: 1 });
  Sync.pushItem('invoices', { id: 'inv_b', subtotal: 2 });
  await new Promise(r => setImmediate(r));
  check('both refused writes are reported',
    pending.includes(2), `onSyncPending values: ${pending.join(',')}`);

  online = true;
  await flushOf(Sync);
  await new Promise(r => setImmediate(r));
  check('back to zero once they land',
    pending[pending.length - 1] === 0, `onSyncPending values: ${pending.join(',')}`);
}

// ── D. A payload the server will never accept does not wedge the queue ────
async function testBadPayloadDropped() {
  console.log('D. a rejected-as-malformed write is dropped, not retried forever');

  const ls = makeStore({});
  const { Sync } = boot(ls, async (url, opts) =>
    (opts && opts.method === 'POST') ? json({ error: 'bad putItem' }, 400)
                                     : json({ rev: 1, invoices: [], cashRecs: [], tsPushes: [], cleanLog: [] }));

  Sync.pushItem('invoices', { id: 'inv_bad', subtotal: 1 });
  await new Promise(r => setImmediate(r));
  check('a 400 is not queued for retry',
    pendingOf(Sync) === 0, `pendingCount() = ${pendingOf(Sync)}`);
}

// ── E. resync() rescues data stranded before the page loaded ──────────────
// A PWA resumed from the background never reloads, so the revision check sends
// every pull down the cheap path and the merge that re-pushes missing items
// never runs. The sync button has to be able to force it.
async function testResyncRescuesStrandedData() {
  console.log('E. a forced resync re-pushes items the server never received');

  // Eight days of invoices sitting in local storage that the server has never
  // seen — exactly the state the domain move left devices in.
  const stranded = [{ id: 'inv_x', date: '2026-10-07', subtotal: 300 },
                    { id: 'inv_y', date: '2026-10-09', subtotal: 450 }];
  const ls = makeStore({ bizops_invoices: JSON.stringify(stranded) });

  const { Sync, calls } = boot(ls, async (url, opts) => {
    if (opts && opts.method === 'POST') return json({ ok: true, rev: 7 });
    if (String(url).includes('rev=1')) return json({ rev: 7 });
    return json({ rev: 7, invoices: [], cashRecs: [], tsPushes: [], cleanLog: [] });
  });

  // Pull once so the revision is known, then pull again: the revision has not
  // moved, so this is the state a resumed app is stuck in.
  await Sync.pull();
  const after = calls.length;
  await Sync.pull();
  check('a plain pull on an unchanged revision sends nothing',
    calls.length === after, `extra POSTs: ${JSON.stringify(calls.slice(after))}`);

  if (typeof Sync.resync !== 'function') {
    check('resync() exists', false, 'Sync.resync is not a function');
    return;
  }
  await Sync.resync();
  await new Promise(r => setImmediate(r));

  const sent = calls.filter(c => c.op === 'putItem' && c.coll === 'invoices').map(c => c.id);
  check('both stranded invoices are pushed up',
    sent.includes('inv_x') && sent.includes('inv_y'), `pushed: ${JSON.stringify(sent)}`);
}

(async () => {
  console.log('sync.js regression tests\n');
  await testDirtySurvivesReload();
  await testBacklogRetriedWithoutRevChange();
  await testHeaderReportsBacklog();
  await testBadPayloadDropped();
  await testResyncRescuesStrandedData();
  console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
