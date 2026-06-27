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

module.exports = async (req, res) => {
  const origin  = req.headers.origin || '';
  const allowed = process.env.APP_ORIGIN || '';

  res.setHeader('Access-Control-Allow-Origin', allowed || '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Only allow requests from our own origin (when APP_ORIGIN is configured)
  if (allowed && origin && origin !== allowed) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!body.messages) return res.status(400).json({ error: 'Missing messages' });

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
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
