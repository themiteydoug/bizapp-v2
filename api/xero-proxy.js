/**
 * Netlify Function: xero-proxy
 * Proxies Xero API calls server-side using the stored access token.
 *
 * Environment variables required:
 *   XERO_CLIENT_ID      — your Xero app client ID
 *   XERO_CLIENT_SECRET  — your Xero app client secret
 *   XERO_TENANT_ID      — your Xero organisation tenant ID
 *   APP_ORIGIN          — https://spcod.netlify.app
 */

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://spcod.netlify.app';
const XERO_BASE      = 'https://api.xero.com/api.xro/2.0';
const XERO_PAYROLL   = 'https://api.xero.com/payroll.xro/1.0';

// Accounting API endpoints (non-payroll)
const ALLOWED_ENDPOINTS = [
  '/Invoices',
  '/PayItems',
  '/Contacts',
  '/Reports',   // P&L, Balance Sheet etc — used for overhead average
];

// Payroll API endpoints
const ALLOWED_PAYROLL_ENDPOINTS = [
  '/Timesheets',
  '/Employees',
  '/PayItems',
];

const corsHeaders = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Access-Token',
};

// Attempt a token refresh using the stored refresh_token header
async function refreshToken(refreshToken) {
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) return null;
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (!['GET', 'POST', 'PUT'].includes(event.httpMethod)) {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Access token sent by browser in X-Access-Token header
  const accessToken = event.headers['x-access-token'];
  if (!accessToken) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Missing X-Access-Token header' }) };
  }

  const endpoint  = event.queryStringParameters?.endpoint;
  const isPayroll = event.queryStringParameters?.payroll === 'true';

  if (!endpoint) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing endpoint query parameter' }) };
  }

  // Whitelist check
  const allowed  = isPayroll ? ALLOWED_PAYROLL_ENDPOINTS : ALLOWED_ENDPOINTS;
  const isAllowed = allowed.some(e => endpoint.startsWith(e));
  if (!isAllowed) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: `Endpoint not permitted: ${endpoint}` }) };
  }

  const base = isPayroll ? XERO_PAYROLL : XERO_BASE;

  // Build query string (strip our routing params)
  const queryParams = { ...event.queryStringParameters };
  delete queryParams.endpoint;
  delete queryParams.payroll;
  const qs = Object.keys(queryParams).length ? '?' + new URLSearchParams(queryParams) : '';

  const url = `${base}${endpoint}${qs}`;

  const xeroHeaders = {
    'Authorization':  `Bearer ${accessToken}`,
    'Xero-Tenant-Id': process.env.XERO_TENANT_ID,
    'Content-Type':   'application/json',
    'Accept':         'application/json',
  };

  try {
    const response = await fetch(url, {
      method:  event.httpMethod,
      headers: xeroHeaders,
      body:    event.body || undefined,
    });

    // If 401, try token refresh (if browser sent a refresh token header)
    if (response.status === 401) {
      const rt = event.headers['x-refresh-token'];
      if (rt) {
        const newTokens = await refreshToken(rt);
        if (newTokens) {
          // Retry with fresh access token
          const retryRes = await fetch(url, {
            method:  event.httpMethod,
            headers: { ...xeroHeaders, 'Authorization': `Bearer ${newTokens.access_token}` },
            body:    event.body || undefined,
          });
          const retryData = await retryRes.json();
          return {
            statusCode: retryRes.status,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              // Pass new tokens back so browser can store them
              'X-New-Access-Token':  newTokens.access_token,
              'X-New-Refresh-Token': newTokens.refresh_token,
              'X-New-Expires-In':    String(newTokens.expires_in),
            },
            body: JSON.stringify(retryData),
          };
        }
      }
    }

    const data = await response.json();
    return {
      statusCode: response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Xero API request failed', detail: err.message }),
    };
  }
};
