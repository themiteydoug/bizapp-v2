/**
 * Vercel Function: xero-auth
 * Xero OAuth — exchanges the auth code for tokens and stores them SERVER-SIDE
 * (in KV). The browser never receives the tokens. Also reports connection
 * status and handles disconnect.
 *
 * Env: XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI, APP_ORIGIN,
 *      KV_REST_API_URL / _TOKEN
 */

const xero = require('../lib/xero');

// Sanitised, not used raw. A value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value: setHeader()
// throws ERR_INVALID_CHAR and this function 500s before running any of its own
// logic. That took out PIN login, sync and Xero at once. Also drops a trailing
// slash so origin comparisons stay stable.
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au')
  .replace(/[\r\n\t]/g, '').trim().replace(/\/+$/, '');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, code } = body;

  try {
    // ── Connection status ──
    if (action === 'status') {
      const t = await xero.getTokens();
      return res.status(200).json({ connected: !!(t && t.refresh_token), tenantName: t?.tenantName || null });
    }

    // ── Disconnect ──
    if (action === 'disconnect') {
      await xero.clearTokens();
      return res.status(200).json({ connected: false });
    }

    // ── Exchange auth code for tokens (store server-side) ──
    if (action === 'exchange') {
      if (!code) return res.status(400).json({ error: 'Missing code' });
      const redirectUri = process.env.XERO_REDIRECT_URI
        || 'https://pcw.spottedcod.com.au/xero-callback.html';

      const { ok, status, data } = await xero.exchangeCode(code, redirectUri);
      if (!ok) {
        return res.status(status).json({ error: data.error, description: data.error_description });
      }

      // Resolve the organisation (tenant) for this connection.
      let tenantId = null, tenantName = null;
      try {
        const connRes = await fetch('https://api.xero.com/connections', {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (connRes.ok) {
          const connections = await connRes.json();
          if (connections.length) { tenantId = connections[0].tenantId; tenantName = connections[0].tenantName; }
        }
      } catch (_) {}

      await xero.saveTokens({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_in:    data.expires_in || 1800,
        savedAt:       Date.now(),
        tenantId,
        tenantName,
      });

      // Tokens are NOT returned to the browser — only the org name for the toast.
      return res.status(200).json({ connected: true, tenantName });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(500).json({ error: 'Xero auth failed', detail: err.message });
  }
};
