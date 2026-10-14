/**
 * The configuration that actually broke the app.
 *
 * APP_ORIGIN was pointed at the new domain alone during the domain move. Every
 * write from every device was refused for a week, silently, because a failed
 * write said nothing. Build 92 listed both addresses in api/data.js's fallback
 * default — which the environment variable overrides, so it changed nothing.
 *
 * The rule that holds regardless of what APP_ORIGIN says: a request whose
 * Origin is the very host it arrived on is ours, and may write.
 *
 * Run: node test/origins-env.test.js
 */
const { execFileSync } = require('child_process');
const path = require('path');

const CASE = path.join(__dirname, '_origin-case.js');

function run({ appOrigin, method = 'POST', origin, host }) {
  const env = { ...process.env, CASE_METHOD: method };
  if (appOrigin) env.APP_ORIGIN = appOrigin; else delete env.APP_ORIGIN;
  if (origin) env.CASE_ORIGIN = origin; else delete env.CASE_ORIGIN;
  if (host) env.CASE_HOST = host; else delete env.CASE_HOST;
  const [code, acao] = execFileSync(process.execPath, [CASE], { env, encoding: 'utf8' })
    .trim().split('\n');
  return { code: Number(code), acao: (acao || '').trim() };
}

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fails++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};

const NEW      = 'https://pcw.spottedcod.com.au';
const OLD      = 'https://bizapp-v2.vercel.app';
const NEW_HOST = 'pcw.spottedcod.com.au';
const OLD_HOST = 'bizapp-v2.vercel.app';

console.log('origin handling with APP_ORIGIN set (the live configuration)\n');

// ── The outage, reproduced ─────────────────────────────────────────────────
console.log('APP_ORIGIN names the new domain only — the state since 7 Oct');
{
  const only = NEW;

  let r = run({ appOrigin: only, method: 'GET', origin: null, host: NEW_HOST });
  check('a same-origin GET still reads (no Origin header is sent)', r.code === 200, `got ${r.code}`);

  r = run({ appOrigin: only, method: 'POST', origin: NEW, host: NEW_HOST });
  check('a write from the new address is accepted', r.code !== 403, `got ${r.code}`);

  // This is the one that was failing in production and that build 92 missed.
  r = run({ appOrigin: only, method: 'POST', origin: OLD, host: OLD_HOST });
  check('a write from a device still on the OLD address is accepted',
    r.code !== 403, `got ${r.code} — every write from that device is being dropped`);

  r = run({ appOrigin: only, method: 'GET', origin: OLD, host: OLD_HOST });
  check('and it can read, so the two are consistent', r.code !== 403, `got ${r.code}`);

  check('the allow-origin header echoes the address the device is on',
    run({ appOrigin: only, method: 'POST', origin: OLD, host: OLD_HOST }).acao === OLD,
    `got "${run({ appOrigin: only, method: 'POST', origin: OLD, host: OLD_HOST }).acao}"`);
}

// ── Any future address works without touching the variable ────────────────
console.log('\na third address nobody has configured');
{
  const r = run({ appOrigin: NEW, method: 'POST',
                  origin: 'https://pcw.macberg.net', host: 'pcw.macberg.net' });
  check('serving the app somewhere new does not need APP_ORIGIN updated first',
    r.code !== 403, `got ${r.code}`);
}

// ── And a genuine outsider is still refused ───────────────────────────────
console.log('\nsomeone else\'s page');
{
  // A page on another site sends its own Origin; Host stays ours.
  let r = run({ appOrigin: NEW, method: 'POST', origin: 'https://evil.example', host: NEW_HOST });
  check('a cross-site write is refused', r.code === 403, `got ${r.code}`);

  r = run({ appOrigin: NEW, method: 'GET', origin: 'https://evil.example', host: NEW_HOST });
  check('a cross-site read is refused', r.code === 403, `got ${r.code}`);

  check('and it is never echoed back in the allow-origin header',
    r.acao !== 'https://evil.example', `got "${r.acao}"`);

  // A lookalike host must not pass on a substring.
  r = run({ appOrigin: NEW, method: 'POST',
            origin: 'https://pcw.spottedcod.com.au.evil.example', host: NEW_HOST });
  check('a lookalike hostname is refused', r.code === 403, `got ${r.code}`);
}

// ── A port or trailing slash must not break a legitimate device ───────────
console.log('\nsloppy but legitimate values');
{
  let r = run({ appOrigin: NEW + '/', method: 'POST', origin: NEW, host: NEW_HOST });
  check('a trailing slash in APP_ORIGIN is tolerated', r.code !== 403, `got ${r.code}`);

  r = run({ appOrigin: NEW + '\n', method: 'POST', origin: NEW, host: NEW_HOST });
  check('a trailing newline in APP_ORIGIN does not 500 the function',
    r.code !== 403 && r.code !== 500, `got ${r.code}`);

  r = run({ appOrigin: 'https://other.example', method: 'POST',
            origin: 'http://localhost:3000', host: 'localhost:3000' });
  check('a host:port pair matches its own origin', r.code !== 403, `got ${r.code}`);
}

console.log(fails ? `\n${fails} failing check(s)` : '\nall checks passed');
process.exit(fails ? 1 : 0);
