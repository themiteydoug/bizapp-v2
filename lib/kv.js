/**
 * Minimal Upstash/Vercel-KV REST helper for serverless functions.
 * Uses the same env vars the app's KV store already provides.
 */
const KV_URL   = process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function configured() { return !!(KV_URL && KV_TOKEN); }

async function cmd(command) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `KV HTTP ${r.status}`);
  return data.result;
}

async function get(key) {
  const v = await cmd(['GET', key]);
  if (v == null) return null;
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}
async function set(key, value) { return cmd(['SET', key, JSON.stringify(value)]); }
async function del(key) { return cmd(['DEL', key]); }

module.exports = { configured, get, set, del };
