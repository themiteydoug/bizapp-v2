/**
 * Vercel Function: square-proxy
 * Proxies all Square API calls server-side so the access token
 * never reaches the browser.
 *
 * Environment variables required (set in Vercel dashboard):
 *   SQUARE_ACCESS_TOKEN   — your Square production access token
 *   SQUARE_LOCATION_ID    — your Square location ID
 *   SQUARE_ENVIRONMENT    — 'production' or 'sandbox'
 *   APP_ORIGIN            — https://pcw.spottedcod.com.au
 */

const SQUARE_BASE = process.env.SQUARE_ENVIRONMENT === 'sandbox'
  ? 'https://connect.squareupsandbox.com/v2'
  : 'https://connect.squareup.com/v2';

const ALLOWED_ENDPOINTS = [
  '/orders/search',
  '/payments',
  '/refunds',
  '/labor/shifts',
  '/labor/timecards',
  '/labor/scheduled-shifts',   // rostered (published) shifts for the roster view
  '/employees',
  '/team-members',
  '/cash-drawers/shifts',
  '/locations',
  '/payouts',
];

// Sanitised, not used raw. A value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value: setHeader()
// throws ERR_INVALID_CHAR and this function 500s before running any of its own
// logic. That took out PIN login, sync and Xero at once. Also drops a trailing
// slash so origin comparisons stay stable.
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au')
  .replace(/[\r\n\t]/g, '').trim().replace(/\/+$/, '');

/**
 * Response trimming (opt in with _trim=1)
 * ---------------------------------------
 * Square returns the whole object graph — every line item, modifier, tax line,
 * card detail and receipt URL. The app reads a handful of fields and throws the
 * rest away, after paying to ship it out of the origin. A day of trading comes
 * back as hundreds of kilobytes to produce two numbers.
 *
 * Each projection below keeps EXACTLY the fields its caller in js/api-square.js
 * reads. Adding a field to a caller means adding it here as well, or it will
 * silently arrive undefined and be counted as zero.
 *
 * Trimming is opt-in per call so that is a visible decision at the call site,
 * and it is skipped entirely on an error response so debugging detail survives.
 */
const money = m => (m && typeof m.amount === 'number') ? { amount: m.amount } : undefined;

const TRIM = {
  // fetchTakingsReal: state, tenders, and the net/total money fields
  '/orders/search': d => ({
    orders: (d.orders || []).map(o => ({
      state:           o.state,
      total_money:     money(o.total_money),
      total_tip_money: money(o.total_tip_money),
      total_tax_money: money(o.total_tax_money),
      net_amounts: o.net_amounts ? {
        total_money: money(o.net_amounts.total_money),
        tip_money:   money(o.net_amounts.tip_money),
        tax_money:   money(o.net_amounts.tax_money),
      } : undefined,
      tenders: (o.tenders || []).map(t => ({ type: t.type, amount_money: money(t.amount_money) })),
    })),
    cursor: d.cursor,
  }),

  // fetchWeeklyPayments: cash vs card split of completed payments
  '/payments': d => ({
    payments: (d.payments || []).map(p => ({
      status:       p.status,
      source_type:  p.source_type,
      amount_money: money(p.amount_money),
    })),
    cursor: d.cursor,
  }),

  // fetchWeeklyRefunds: completed refunds, split by where the money went
  '/refunds': d => ({
    refunds: (d.refunds || []).map(r => ({
      status:           r.status,
      destination_type: r.destination_type,
      amount_money:     money(r.amount_money),
    })),
    cursor: d.cursor,
  }),

  // fetchTimesheetsReal: worked time, unpaid breaks and the rate at clock-in
  '/labor/timecards/search': d => ({
    timecards: (d.timecards || []).map(t => ({
      deleted:        t.deleted,
      team_member_id: t.team_member_id,
      start_at:       t.start_at,
      end_at:         t.end_at,
      breaks: (t.breaks || []).map(b => ({ is_paid: b.is_paid, start_at: b.start_at, end_at: b.end_at })),
      wage: t.wage ? { hourly_rate: money(t.wage.hourly_rate) } : undefined,
    })),
    cursor: d.cursor,
  }),

  // getRosterWeek: published shifts, plus enough of the drafts to count them
  '/labor/scheduled-shifts/search': d => ({
    scheduled_shifts: (d.scheduled_shifts || []).map(s => ({
      id: s.id,
      published_shift_details: s.published_shift_details ? {
        team_member_id: s.published_shift_details.team_member_id,
        job_id:         s.published_shift_details.job_id,
        start_at:       s.published_shift_details.start_at,
        end_at:         s.published_shift_details.end_at,
        notes:          s.published_shift_details.notes,
        is_deleted:     s.published_shift_details.is_deleted,
      } : undefined,
      draft_shift_details: s.draft_shift_details ? { is_deleted: s.draft_shift_details.is_deleted } : undefined,
    })),
    cursor: d.cursor,
  }),

  // getWeeklyPayouts — covers both the list and the per-payout entries, since a
  // response carries one array or the other, never both.
  '/payouts': d => ({
    payouts:        (d.payouts || []).map(p => ({ id: p.id })),
    payout_entries: (d.payout_entries || []).map(e => ({ type: e.type, amount_money: money(e.amount_money) })),
    cursor: d.cursor,
  }),
};

function trimFor(endpoint) {
  const key = Object.keys(TRIM).find(k => endpoint.startsWith(k));
  return key ? TRIM[key] : null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  // Live financial data — never let a browser or CDN cache a Square response.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
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
  delete queryParams._cb;        // client cache-buster — never forward to Square
  const wantsTrim = queryParams._trim === '1';
  delete queryParams._trim;      // ours, not Square's

  // Inject location_id server-side where needed (only if env var is actually set)
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (
    locationId &&
    (endpoint.startsWith('/cash-drawers') || endpoint.startsWith('/labor/') || endpoint.startsWith('/employees') || endpoint.startsWith('/payments') || endpoint.startsWith('/refunds')) &&
    !queryParams.location_id
  ) {
    queryParams.location_id = locationId;
  }

  // Strip any undefined values to avoid sending literal "undefined" to Square
  Object.keys(queryParams).forEach(k => {
    if (queryParams[k] === undefined || queryParams[k] === 'undefined') delete queryParams[k];
  });

  const queryString = Object.keys(queryParams).length
    ? '?' + new URLSearchParams(queryParams).toString()
    : '';

  const url = `${SQUARE_BASE}${targetEndpoint}${queryString}`;

  // Only POST requests carry a body. GET/HEAD must never have one — Square's
  // fetch rejects "Request with GET/HEAD method cannot have body." Vercel parses
  // an empty JSON body into req.body={} even on GETs, so guard strictly on method.
  let requestBody;
  if (req.method === 'POST' && req.body) {
    const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (endpoint === '/orders/search') {
      if (!parsed.location_ids?.length) parsed.location_ids = [locationId];
    }
    if (endpoint === '/labor/timecards/search' || endpoint === '/labor/scheduled-shifts/search') {
      const filter = parsed.query?.filter;
      if (filter && (!filter.location_ids?.length)) filter.location_ids = [locationId];
    }
    if (endpoint === '/team-members/search') {
      if (!parsed.query) parsed.query = {};
      if (!parsed.query.filter) parsed.query.filter = {};
      if (!parsed.query.filter.location_ids?.length) parsed.query.filter.location_ids = [locationId];
    }
    requestBody = JSON.stringify(parsed);
  }

  // Debug mode: return the URL we'd call without actually calling Square
  if (req.query._debug === '1') {
    return res.status(200).json({ url, locationId: locationId || '(not set)', queryParams });
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

    // Read as text first so a non-JSON upstream body doesn't throw and mask the real error
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      // Upstream returned non-JSON (HTML error page, empty body, etc.)
      return res.status(response.ok ? 502 : response.status).json({
        error: 'Square returned non-JSON response',
        _debug: { url, squareStatus: response.status, body: rawText.slice(0, 500) },
      });
    }
    // Attach debug info on errors so the client can see the exact Square response
    if (!response.ok) {
      return res.status(response.status).json({ ...data, _debug: { url, squareStatus: response.status } });
    }
    // Only a successful response is trimmed — an error body goes back whole.
    const trim = wantsTrim ? trimFor(endpoint) : null;
    return res.status(response.status).json(trim ? trim(data) : data);
  } catch (err) {
    return res.status(500).json({ error: 'Square API request failed', detail: err.message, _debug: { url } });
  }
};
