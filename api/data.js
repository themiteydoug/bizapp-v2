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

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://bizapp-v2.vercel.app';
const KV_URL   = process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const PREFIX      = 'pcw:';
const COLLECTIONS = ['invoices', 'cashRecs', 'tsPushes'];      // Redis hashes
const SINGLETONS  = ['settings', 'tsAdjustments', 'staff'];    // Redis string keys

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({ error: 'KV not configured' });
  }

  const origin = req.headers.origin || '';
  const norm = s => (s || '').replace(/\/+$/, '').toLowerCase();
  if (origin && norm(origin) !== norm(ALLOWED_ORIGIN)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // ── Pull the full shared snapshot ──
    if (req.method === 'GET') {
      const cmds = [
        ...COLLECTIONS.map(c => ['HGETALL', PREFIX + c]),
        ...SINGLETONS.map(k => ['GET', PREFIX + k]),
      ];
      const out = await kv(cmds);   // pipeline → [{result}, ...]
      const snap = {};
      COLLECTIONS.forEach((c, i) => {
        const flat = out[i]?.result || [];   // [field, val, field, val, ...]
        const arr = [];
        for (let j = 1; j < flat.length; j += 2) {
          const parsed = safeParse(flat[j]);
          if (parsed) arr.push(parsed);
        }
        snap[c] = arr;
      });
      SINGLETONS.forEach((k, i) => {
        snap[k] = safeParse(out[COLLECTIONS.length + i]?.result);
      });
      return res.status(200).json(snap);
    }

    // ── Write ──
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const op = body.op;

      if (op === 'putItem') {
        if (!COLLECTIONS.includes(body.coll) || body.id == null || body.value == null) {
          return res.status(400).json({ error: 'bad putItem' });
        }
        await kv(['HSET', PREFIX + body.coll, String(body.id), JSON.stringify(body.value)]);
        return res.status(200).json({ ok: true });
      }

      if (op === 'putKey') {
        if (!SINGLETONS.includes(body.key) || body.value == null) {
          return res.status(400).json({ error: 'bad putKey' });
        }
        await kv(['SET', PREFIX + body.key, JSON.stringify(body.value)]);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'unknown op' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
