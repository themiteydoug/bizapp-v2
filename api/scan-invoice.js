/**
 * BizOps · Anthropic API Proxy
 * Vercel Edge Function — /api/scan-invoice
 *
 * Keeps your Anthropic API key server-side and never exposed in the browser.
 * Vercel runs this automatically when the app calls /api/scan-invoice
 *
 * Setup:
 *   1. In Vercel dashboard → your project → Settings → Environment Variables
 *   2. Add:  ANTHROPIC_API_KEY = sk-ant-...
 *   3. Redeploy — done. The key never touches the browser.
 */

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Basic origin check — only allow requests from your own domain
  const origin = req.headers.get('origin') || '';
  const allowed = process.env.ALLOWED_ORIGIN || ''; // set in Vercel env vars
  if (allowed && origin !== allowed) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();

    // Forward the request to Anthropic
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-20250514',
        max_tokens: 1000,
        messages:   body.messages,  // passed from the app
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'Anthropic error' }), {
        status: anthropicRes.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': allowed || '*',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
