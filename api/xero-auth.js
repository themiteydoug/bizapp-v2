/**
 * Vercel Function: xero-auth
 * Handles Xero OAuth 2.0 token exchange and refresh server-side.
 * The CLIENT_SECRET never reaches the browser.
 *
 * Environment variables required (set in Vercel dashboard):
 *   XERO_CLIENT_ID      — your Xero app client ID
 *   XERO_CLIENT_SECRET  — your Xero app client secret
 *   XERO_REDIRECT_URI   — https://bizapp-v2.vercel.app/xero-callback.html
 *   APP_ORIGIN          — https://bizapp-v2.vercel.app
 */

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://bizapp-v2.vercel.app';

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
  const { action, code, refresh_token } = body;

  if (!['exchange', 'refresh'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  try {
    const tokenParams = {
      client_id:     process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
    };

    if (action === 'exchange') {
      if (!code) return res.status(400).json({ error: 'Missing code' });
      tokenParams.grant_type   = 'authorization_code';
      tokenParams.code         = code;
      tokenParams.redirect_uri = process.env.XERO_REDIRECT_URI
        || 'https://bizapp-v2.vercel.app/xero-callback.html';
    } else {
      if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
      tokenParams.grant_type    = 'refresh_token';
      tokenParams.refresh_token = refresh_token;
    }

    // Exchange with Xero
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      return res.status(tokenRes.status).json({ error: err.error, description: err.error_description });
    }

    const tokens = await tokenRes.json();

    // Fetch tenant ID automatically after exchange
    let tenantId = null;
    let tenantName = null;
    if (action === 'exchange') {
      const connRes = await fetch('https://api.xero.com/connections', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
      });
      if (connRes.ok) {
        const connections = await connRes.json();
        if (connections.length > 0) {
          tenantId   = connections[0].tenantId;
          tenantName = connections[0].tenantName;
        }
      }
    }

    // Return tokens to browser — but NOT the client secret (it never leaves this function)
    return res.status(200).json({
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in:    tokens.expires_in,
      tenantId,
      tenantName,
    });

  } catch (err) {
    return res.status(500).json({ error: 'Token exchange failed', detail: err.message });
  }
};
