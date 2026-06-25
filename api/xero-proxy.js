/**
 * Vercel Function: xero-proxy
 * Proxies Xero API calls server-side using the stored access token.
 *
 * Environment variables required:
 *   XERO_CLIENT_ID      — your Xero app client ID
 *   XERO_CLIENT_SECRET  — your Xero app client secret
 *   XERO_TENANT_ID      — your Xero organisation tenant ID
 *   APP_ORIGIN          — https://bizapp-v2.vercel.app
 */

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://bizapp-v2.vercel.app';
const XERO_BASE      = 'https://api.xero.com/api.xro/2.0';
const XERO_PAYROLL   = 'https://api.xero.com/payroll.xro/1.0';

const ALLOWED_ENDPOINTS = [
  '/Invoices',
  '/PayItems',
  '/Contacts',
  '/Reports',
];

const ALLOWED_PAYROLL_ENDPOINTS = [
  '/Timesheets',
  '/Employees',
  '/PayItems',
];

function setCors(res, extra = {}) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token, X-Refresh-Token');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

async function doRefresh(refreshToken) {
  const r = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
    }),
  });
  if (!r.ok) return null;
  return r.json();
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  const accessToken = req.headers['x-access-token'];
  if (!accessToken) return res.status(401).json({ error: 'Missing X-Access-Token header' });

  const endpoint  = req.query.endpoint;
  const isPayroll = req.query.payroll === 'true';

  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint query parameter' });

  const allowed   = isPayroll ? ALLOWED_PAYROLL_ENDPOINTS : ALLOWED_ENDPOINTS;
  const isAllowed = allowed.some(e => endpoint.startsWith(e));
  if (!isAllowed) return res.status(403).json({ error: `Endpoint not permitted: ${endpoint}` });

  const base = isPayroll ? XERO_PAYROLL : XERO_BASE;

  const queryParams = { ...req.query };
  delete queryParams.endpoint;
  delete queryParams.payroll;
  const qs = Object.keys(queryParams).length ? '?' + new URLSearchParams(queryParams) : '';
  const url = `${base}${endpoint}${qs}`;

  const requestBody = req.body
    ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    : undefined;

  const makeHeaders = (token) => ({
    'Authorization':  `Bearer ${token}`,
    'Xero-Tenant-Id': process.env.XERO_TENANT_ID,
    'Content-Type':   'application/json',
    'Accept':         'application/json',
  });

  try {
    let response = await fetch(url, {
      method:  req.method,
      headers: makeHeaders(accessToken),
      body:    requestBody,
    });

    // If 401, try refresh token
    if (response.status === 401) {
      const rt = req.headers['x-refresh-token'];
      if (rt) {
        const newTokens = await doRefresh(rt);
        if (newTokens) {
          response = await fetch(url, {
            method:  req.method,
            headers: makeHeaders(newTokens.access_token),
            body:    requestBody,
          });
          const data = await response.json();
          res.setHeader('X-New-Access-Token',  newTokens.access_token);
          res.setHeader('X-New-Refresh-Token', newTokens.refresh_token);
          res.setHeader('X-New-Expires-In',    String(newTokens.expires_in));
          return res.status(response.status).json(data);
        }
      }
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Xero API request failed', detail: err.message });
  }
};
