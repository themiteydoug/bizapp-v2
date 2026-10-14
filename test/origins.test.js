// Reproduces the sync failure and proves the fix. The bug was an asymmetry:
// browsers omit Origin on a same-origin GET but send it on a POST, so a device
// left on the old address could pull everything and push nothing — silently.
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'token';
delete process.env.APP_ORIGIN;              // exercise the built-in default

global.fetch = async () => ({ ok: true, json: async () => [{ result: '1' }, { result: [] }, { result: [] }, { result: [] }, { result: null }, { result: null }, { result: null }, { result: null }, { result: null }, { result: null }] });

const handler = require('/home/user/bizapp-v2/api/data.js');

function mockRes() {
  const r = { headers: {}, code: null, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const call = async (method, origin, query = {}) => {
  const res = mockRes();
  await handler({ method, query, headers: origin ? { origin } : {}, body: undefined }, res);
  return res;
};

let fails = 0;
const eq = (got, want, what) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) { fails++; console.log(`FAIL ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  else console.log('ok   ' + what);
};

const NEW = 'https://pcw.spottedcod.com.au';
const OLD = 'https://bizapp-v2.vercel.app';

(async () => {
  // ── The shape of the bug ───────────────────────────────────
  eq((await call('GET', null, { rev: '1' })).code, 200,
     'a same-origin GET carries no Origin header and is allowed — this always worked');
  eq((await call('POST', OLD)).code !== 403, true,
     'a POST from the OLD address is no longer refused — this is what broke sync');

  // ── Both addresses work, for both verbs ────────────────────
  for (const [label, o] of [['new', NEW], ['old', OLD]]) {
    eq((await call('GET', o, { rev: '1' })).code, 200, `GET from the ${label} address is allowed`);
    const post = await call('POST', o);
    eq(post.code !== 403, true, `POST from the ${label} address is allowed`);
  }

  // ── A stranger is still refused ────────────────────────────
  const evil = await call('POST', 'https://evil.example');
  eq([evil.code, evil.body.error], [403, 'Forbidden'], 'an unknown origin is still refused');
  eq((await call('GET', 'https://evil.example', { rev: '1' })).code, 403, 'including on a GET');

  // ── The CORS header names the caller, not a fixed address ──
  eq((await call('GET', OLD, { rev: '1' })).headers['Access-Control-Allow-Origin'], OLD,
     'the allow-origin header echoes the caller');
  eq((await call('GET', NEW, { rev: '1' })).headers['Access-Control-Allow-Origin'], NEW,
     'for either address');
  eq((await call('GET', 'https://evil.example', { rev: '1' })).headers['Access-Control-Allow-Origin'], NEW,
     'and falls back to the canonical one for anyone else');
  eq((await call('GET', NEW, { rev: '1' })).headers['Vary'], 'Origin',
     'Vary: Origin is set, since the header now depends on the caller');

  // ── Trailing slashes, case and whitespace still tolerated ──
  for (const variant of [NEW + '/', NEW.toUpperCase(), ' ' + NEW + ' ']) {
    eq((await call('POST', variant)).code !== 403, true, `tolerates ${JSON.stringify(variant)}`);
  }

  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
