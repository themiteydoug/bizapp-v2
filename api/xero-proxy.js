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

  if (!process.env.XERO_TENANT_ID) {
    return res.status(500).json({ error: 'XERO_TENANT_ID not set in Vercel environment variables' });
  }

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

  // GET/HEAD must never carry a body — Xero's fetch rejects it with
  // "Request with GET/HEAD method cannot have body." Vercel parses an empty
  // JSON body into req.body={} even on GETs, so guard strictly on method.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.body
    && !(typeof req.body === 'object' && Object.keys(req.body).length === 0);
  const requestBody = hasBody
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

    // Read as text first so a non-JSON upstream body doesn't throw and mask the error
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(response.ok ? 502 : response.status).json({
        error: 'Xero returned non-JSON response',
        _debug: { url, xeroStatus: response.status, body: rawText.slice(0, 500) },
      });
    }
    if (!response.ok) {
      return res.status(response.status).json({ ...data, _debug: { url, xeroStatus: response.status } });
    }
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Xero API request failed', detail: err.message, _debug: { url } });
  }
};
