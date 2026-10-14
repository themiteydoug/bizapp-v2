/**
 * PCW · Shared data store  (/api/data)
 * Vercel Node serverless function backed by Vercel KV (Upstash Redis REST).
 *
 * Lets every device share live data (invoices, cash recs, timesheet logs,
 * settings, staff) instead of each phone keeping its own localStorage copy.
 *
 * Storage model:
 *   - Collections (append/update, no delete) → Redis HASH  id -> JSON
 *       pcw:invoices, pcw:cashRecs, pcw:tsPushes
 *   - Singletons (whole-object) → Redis STRING JSON
 *       pcw:settings, pcw:tsAdjustments, pcw:staff
 *
 * Env (auto-added when you create a Vercel KV store and connect the project):
 *   KV_REST_API_URL, KV_REST_API_TOKEN   (or UPSTASH_REDIS_REST_URL/TOKEN)
 *
 * If KV isn't configured the endpoint returns 503 and the app silently falls
 * back to local-only mode — nothing breaks.
 */

// The app answers on more than one address while a domain move settles, and a
// device whose home-screen icon still points at the old one would otherwise be
// able to READ but not WRITE: browsers omit Origin on a same-origin GET but
// send it on a POST, so every pull passed and every push was rejected 403 —
// silently, because a failed write says nothing. Set APP_ORIGIN to a
// comma-separated list; the first entry is the canonical one.
//
// Sanitised, not used raw: a value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value, and
// setHeader() then throws ERR_INVALID_CHAR before the function runs at all.
const ALLOWED_ORIGINS = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au,https://bizapp-v2.vercel.app')
  .replace(/[\r\n\t]/g, '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const normOrigin = s => (s || '').trim().replace(/\/+$/, '').toLowerCase();
const originAllowed = o => !o || ALLOWED_ORIGINS.some(a => normOrigin(a) === normOrigin(o));
// Echo back the caller's own origin when we trust it, so the CORS header is
// right for whichever address the device is on.
const originHeader = o => (o && originAllowed(o)) ? o.trim().replace(/\/+$/, '') : ALLOWED_ORIGINS[0];
const KV_URL   = process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const PREFIX      = 'pcw:';
const COLLECTIONS = ['invoices', 'cashRecs', 'tsPushes', 'cleanLog'];   // Redis hashes
const SINGLETONS  = ['settings', 'tsAdjustments', 'staff', 'supplierFingerprints', 'tombstones', 'cleanJobs']; // Redis string keys

// Bumped by every write. Pollers read this instead of re-downloading the whole
// snapshot each time — the snapshot grows with every invoice and cash count, so
// polling it outright cost hundreds of megabytes a day per open device.
const REV_KEY = PREFIX + 'rev';

function cors(res, req) {
  res.setHeader('Access-Control-Allow-Origin', originHeader(req && req.headers.origin));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Shared live data — never let a CDN or browser serve a stale copy.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

// Run a single Redis command (array) or a pipeline (array of arrays).
async function kv(commands) {
  const isPipeline = Array.isArray(commands[0]);
  const url = isPipeline ? `${KV_URL}/pipeline` : KV_URL;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `KV HTTP ${r.status}`);
  return data;
}

function safeParse(v) {
  if (v == null) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}

module.exports = async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'KV not configured' });
  }

  if (!originAllowed(req.headers.origin)) {
    return res.status(403).json({ error: 'Forbidden', _debug: { origin: req.headers.origin } });
  }

  try {
    // ── Fetch a single invoice photo by id (kept out of the snapshot) ──
    if (req.method === 'GET' && req.query.photo) {
      const out = await kv(['HGET', PREFIX + 'invoicePhotos', String(req.query.photo)]);
      return res.status(200).json({ id: req.query.photo, dataUrl: out?.result || null });
    }

    // ── Has anything changed? A few bytes, asked every poll ──
    if (req.method === 'GET' && req.query.rev) {
      const out = await kv(['GET', REV_KEY]);
      return res.status(200).json({ rev: Number(out?.result) || 0 });
    }

    // ── Pull the full shared snapshot ──
    if (req.method === 'GET') {
      const cmds = [
        ['GET', REV_KEY],          // read FIRST — see the note below
        ...COLLECTIONS.map(c => ['HGETALL', PREFIX + c]),
        ...SINGLETONS.map(k => ['GET', PREFIX + k]),
      ];
      // Reading the revision ahead of the data means a write landing mid-pipeline
      // leaves us with an old revision and new data, so the next poll pulls again
      // — wasteful but harmless. The other order would pair a new revision with
      // old data and that change would never be seen.
      const out = await kv(cmds);   // pipeline → [{result}, ...]
      const snap = { rev: Number(out[0]?.result) || 0 };
      COLLECTIONS.forEach((c, i) => {
        const flat = out[i + 1]?.result || [];   // [field, val, field, val, ...]
        const arr = [];
        for (let j = 1; j < flat.length; j += 2) {
          const parsed = safeParse(flat[j]);
          if (parsed) arr.push(parsed);
        }
        snap[c] = arr;
      });
      SINGLETONS.forEach((k, i) => {
        snap[k] = safeParse(out[COLLECTIONS.length + 1 + i]?.result);
      });
      return res.status(200).json(snap);
    }

    // ── Write ──
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const op = body.op;

      // Every write runs with an INCR on the revision, so a poller elsewhere
      // notices within one tick without pulling anything.
      const write = async cmd => {
        const out = await kv([cmd, ['INCR', REV_KEY]]);
        return Number(out[1]?.result) || 0;
      };

      if (op === 'putItem') {
        if (!COLLECTIONS.includes(body.coll) || body.id == null || body.value == null) {
          return res.status(400).json({ error: 'bad putItem' });
        }
        const rev = await write(['HSET', PREFIX + body.coll, String(body.id), JSON.stringify(body.value)]);
        return res.status(200).json({ ok: true, rev });
      }

      if (op === 'putKey') {
        if (!SINGLETONS.includes(body.key) || body.value == null) {
          return res.status(400).json({ error: 'bad putKey' });
        }
        const rev = await write(['SET', PREFIX + body.key, JSON.stringify(body.value)]);
        return res.status(200).json({ ok: true, rev });
      }

      if (op === 'delItem') {
        if (!COLLECTIONS.includes(body.coll) || body.id == null) {
          return res.status(400).json({ error: 'bad delItem' });
        }
        const rev = await write(['HDEL', PREFIX + body.coll, String(body.id)]);
        return res.status(200).json({ ok: true, rev });
      }

      // Invoice photos live in their own hash, fetched by id (never in the
      // snapshot), so they don't move the revision — nothing polls for them.
      if (op === 'putPhoto') {
        if (body.id == null || body.value == null) return res.status(400).json({ error: 'bad putPhoto' });
        await kv(['HSET', PREFIX + 'invoicePhotos', String(body.id), String(body.value)]);
        return res.status(200).json({ ok: true });
      }
      if (op === 'delPhoto') {
        if (body.id == null) return res.status(400).json({ error: 'bad delPhoto' });
        await kv(['HDEL', PREFIX + 'invoicePhotos', String(body.id)]);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'unknown op' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
