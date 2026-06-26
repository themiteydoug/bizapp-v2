/**
 * Vercel Function: square-proxy
 * Proxies all Square API calls server-side so the access token
 * never reaches the browser.
 *
 * Environment variables required (set in Vercel dashboard):
 *   SQUARE_ACCESS_TOKEN   — your Square production access token
 *   SQUARE_LOCATION_ID    — your Square location ID
 *   SQUARE_ENVIRONMENT    — 'production' or 'sandbox'
 *   APP_ORIGIN            — https://bizapp-v2.vercel.app
 */

const SQUARE_BASE = process.env.SQUARE_ENVIRONMENT === 'sandbox'
  ? 'https://connect.squareupsandbox.com/v2'
  : 'https://connect.squareup.com/v2';

const ALLOWED_ENDPOINTS = [
  '/orders/search',
  '/labor/shifts',
  '/employees',
  '/team-members',
  '/cash-drawers/shifts',
  '/locations',
];

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://bizapp-v2.vercel.app';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  // Validate required env vars up-front for a clear error message
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN env var not set in Vercel' });
  }
  if (!process.env.SQUARE_LOCATION_ID) {
    return res.status(500).json({ error: 'SQUARE_LOCATION_ID env var not set in Vercel' });
  }

  // Parse the target endpoint from query string
  const endpoint = req.query.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint parameter' });

  // Whitelist check — only allow known Square endpoints
  const isAllowed = ALLOWED_ENDPOINTS.some(e => endpoint.startsWith(e));
  if (!isAllowed) return res.status(403).json({ error: 'Endpoint not permitted' });

  // Inject location ID for endpoints that need it
  let targetEndpoint = endpoint;
  if (endpoint.includes('{LOCATION_ID}')) {
    targetEndpoint = endpoint.replace('{LOCATION_ID}', process.env.SQUARE_LOCATION_ID);
  }

  // Build upstream query string (strip our routing params)
  const queryParams = { ...req.query };
  delete queryParams.endpoint;

  // Inject location_id server-side where needed
  if (
    (endpoint.startsWith('/cash-drawers') || endpoint.startsWith('/labor/shifts') || endpoint.startsWith('/employees')) &&
    !queryParams.location_id
  ) {
    queryParams.location_id = process.env.SQUARE_LOCATION_ID;
  }

  const queryString = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';

  const url = `${SQUARE_BASE}${targetEndpoint}${queryString}`;

  // For orders/search POST: inject location_ids into body if missing
  // req.body is pre-parsed by Vercel for application/json requests
  let requestBody;
  if (endpoint === '/orders/search' && req.method === 'POST' && req.body) {
    const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!parsed.location_ids?.length) {
      parsed.location_ids = [process.env.SQUARE_LOCATION_ID];
    }
    requestBody = JSON.stringify(parsed);
  } else if (req.body) {
    requestBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  try {
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2026-05-20',
      },
      body: requestBody,
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Square API request failed', detail: err.message });
  }
};
