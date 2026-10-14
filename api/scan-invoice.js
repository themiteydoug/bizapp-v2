/**
 * BizOps · Anthropic API Proxy  (/api/scan-invoice)
 * Vercel Node serverless function — keeps the Anthropic key server-side.
 *
 * Reads an invoice image (passed as Claude vision messages) and returns the
 * model response. Runs as a standard Node function (not Edge) so it can accept
 * a full-size image upload without hitting Edge's tight request-body limit.
 *
 * Setup:
 *   Vercel → project → Settings → Environment Variables
 *   Add ANTHROPIC_API_KEY = sk-ant-...   then redeploy.
 */

// The app answers on more than one address while a domain move settles, and a
// device whose home-screen icon still points at the old one would otherwise be
// able to READ but not WRITE: browsers omit Origin on a same-origin GET but
// send it on a POST, so every pull passed and every push was rejected 403 —
// silently, because a failed write says nothing. Set APP_ORIGIN to a
// comma-separated list; the first entry is the canonical one.
//
// Sanitised, not used raw: a value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value, and
// setHeader() then throws ERR_INVALID_CHAR before the function runs at all.
const ALLOWED_ORIGINS = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au,https://bizapp-v2.vercel.app')
  .replace(/[\r\n\t]/g, '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const normOrigin = s => (s || '').trim().replace(/\/+$/, '').toLowerCase();
const originAllowed = o => !o || ALLOWED_ORIGINS.some(a => normOrigin(a) === normOrigin(o));
// Echo back the caller's own origin when we trust it, so the CORS header is
// right for whichever address the device is on.
const originHeader = o => (o && originAllowed(o)) ? o.trim().replace(/\/+$/, '') : ALLOWED_ORIGINS[0];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';

  res.setHeader('Access-Control-Allow-Origin', originHeader(origin));
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Only requests from one of our own addresses.
  if (!originAllowed(origin)) {
    return res.status(403).json({ error: 'Forbidden', _debug: { origin, allowed: ALLOWED_ORIGINS } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!body.messages) return res.status(400).json({ error: 'Missing messages' });

    // Multi-page invoices may include PDF pages (content blocks of type
    // 'document'). PDF support in the Messages API is gated behind a beta header;
    // add it only when a document block is actually present.
    const hasPdf = (body.messages || []).some(m =>
      Array.isArray(m.content) && m.content.some(c => c && c.type === 'document'));

    const headers = {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (hasPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages:   body.messages,
      }),
    });

    const raw = await anthropicRes.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      return res.status(502).json({ error: 'Anthropic returned non-JSON', _debug: raw.slice(0, 300) });
    }

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status).json({ error: data.error?.message || 'Anthropic error' });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
