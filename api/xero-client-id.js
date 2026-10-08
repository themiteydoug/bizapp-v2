/**
 * Vercel Function: xero-client-id
 * Returns the Xero OAuth client_id to the browser.
 * The client_id is NOT a secret — it's safe to expose.
 * The client_secret stays server-side in xero-auth.js.
 *
 * Environment variables required:
 *   XERO_CLIENT_ID  — your Xero app client ID
 *   APP_ORIGIN      — https://pcw.spottedcod.com.au
 */

// Sanitised, not used raw. A value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value: setHeader()
// throws ERR_INVALID_CHAR and this function 500s before running any of its own
// logic. That took out PIN login, sync and Xero at once. Also drops a trailing
// slash so origin comparisons stay stable.
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au')
  .replace(/[\r\n\t]/g, '').trim().replace(/\/+$/, '');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'XERO_CLIENT_ID not configured in Vercel environment variables' });
  }

  return res.status(200).json({ client_id: clientId });
};
