/**
 * Netlify Function: square-proxy
 * Proxies all Square API calls server-side so the access token
 * never reaches the browser.
 *
 * Environment variables required (set in Netlify dashboard):
 *   SQUARE_ACCESS_TOKEN   — your Square production access token
 *   SQUARE_LOCATION_ID    — your Square location ID
 *   SQUARE_ENVIRONMENT    — 'production' or 'sandbox'
 *   APP_ORIGIN            — https://spcod.netlify.app
 */

const SQUARE_BASE = process.env.SQUARE_ENVIRONMENT === 'sandbox'
  ? 'https://connect.squareupsandbox.com/v2'
  : 'https://connect.squareup.com/v2';

const ALLOWED_ENDPOINTS = [
  '/orders/search',
  '/labor/shifts',
  '/team-members',
  '/cash-drawers/shifts',
  '/locations',
];

exports.handler = async (event) => {
  // CORS — only allow requests from the app origin
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigin = process.env.APP_ORIGIN || 'https://spcod.netlify.app';

  const corsHeaders = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  // Only allow GET and POST
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Parse the target endpoint from query string
  const endpoint = event.queryStringParameters?.endpoint;
  if (!endpoint) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing endpoint parameter' }) };
  }

  // Whitelist check — only allow known Square endpoints
  const isAllowed = ALLOWED_ENDPOINTS.some(e => endpoint.startsWith(e));
  if (!isAllowed) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Endpoint not permitted' }) };
  }

  // Inject location ID for endpoints that need it
  let targetEndpoint = endpoint;
  if (endpoint.includes('{LOCATION_ID}')) {
    targetEndpoint = endpoint.replace('{LOCATION_ID}', process.env.SQUARE_LOCATION_ID);
  }

  // Inject location_id into query params where needed (server-side only)
  let queryParams = event.queryStringParameters ? { ...event.queryStringParameters } : {};
  delete queryParams.endpoint;
  if (
    (endpoint.startsWith('/cash-drawers') || endpoint.startsWith('/labor/shifts')) &&
    !queryParams.location_id
  ) {
    queryParams.location_id = process.env.SQUARE_LOCATION_ID;
  }

  const queryString = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';

  const url = `${SQUARE_BASE}${targetEndpoint}${queryString}`;

  // For orders/search POST: inject location_ids into body if missing
  let requestBody = event.body || undefined;
  if (endpoint === '/orders/search' && event.httpMethod === 'POST' && event.body) {
    try {
      const parsed = JSON.parse(event.body);
      if (!parsed.location_ids?.length) {
        parsed.location_ids = [process.env.SQUARE_LOCATION_ID];
      }
      requestBody = JSON.stringify(parsed);
    } catch (_) { /* leave body as-is */ }
  }

  try {
    const response = await fetch(url, {
      method: event.httpMethod,
      headers: {
        'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'Square-Version': '2026-05-20',
      },
      body: requestBody,
    });

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
      body: JSON.stringify({ error: 'Square API request failed', detail: err.message }),
    };
  }
};
