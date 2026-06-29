/**
 * Server-side Xero token store + refresh.
 * Tokens live in KV (shared across all devices) — the browser never holds them,
 * so there's a single refresh authority and no rotating-token races.
 */
const kv = require('./kv');

const TOKEN_KEY = 'pcw:xero:tokens';

async function getTokens()      { return kv.get(TOKEN_KEY); }
async function saveTokens(t)    { return kv.set(TOKEN_KEY, t); }
async function clearTokens()    { return kv.del(TOKEN_KEY); }

// Exchange an auth code (or refresh) with Xero's identity service.
async function exchangeCode(code, redirectUri) {
  return tokenRequest({
    grant_type:   'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

async function tokenRequest(params) {
  const r = await fetch('https://identity.xero.com/connect/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
      ...params,
    }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Refresh the stored tokens. Returns the new token record, or null if the
// refresh token is dead (in which case the stored tokens are cleared).
async function refresh(tokens) {
  const { ok, status, data } = await tokenRequest({
    grant_type:    'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  if (!ok) {
    if (status === 400 || status === 401) await clearTokens();  // refresh token expired/invalid
    return null;
  }
  const saved = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_in:    data.expires_in || 1800,
    savedAt:       Date.now(),
    tenantId:      tokens.tenantId || null,
    tenantName:    tokens.tenantName || null,
  };
  await saveTokens(saved);
  return saved;
}

// Return a token record with a valid access token (refreshing if needed), or
// null when not connected.
async function getValid() {
  let tokens = await getTokens();
  if (!tokens || !tokens.access_token) return null;
  const expired = Date.now() > (tokens.savedAt + tokens.expires_in * 1000) - 60000;  // 1-min buffer
  if (expired) tokens = await refresh(tokens);
  return tokens || null;
}

module.exports = { getTokens, saveTokens, clearTokens, exchangeCode, refresh, getValid, TOKEN_KEY };
