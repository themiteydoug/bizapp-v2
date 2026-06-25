/**
 * Netlify Function: xero-auth
 * Handles Xero OAuth 2.0 token exchange and refresh server-side.
 * The CLIENT_SECRET never reaches the browser.
 *
 * Environment variables required (set in Netlify dashboard):
 *   XERO_CLIENT_ID      — your Xero app client ID
 *   XERO_CLIENT_SECRET  — your Xero app client secret
 *   XERO_REDIRECT_URI   — https://spcod.netlify.app/xero-callback.html
 *   APP_ORIGIN          — https://spcod.netlify.app
 */

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://spcod.netlify.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action, code, refresh_token } = body;

  if (!['exchange', 'refresh'].includes(action)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  try {
    // Build token request
    const tokenParams = {
      client_id:     process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET,
    };

    if (action === 'exchange') {
      if (!code) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing code' }) };
      tokenParams.grant_type    = 'authorization_code';
      tokenParams.code          = code;
      tokenParams.redirect_uri  = process.env.XERO_REDIRECT_URI;
    } else {
      if (!refresh_token) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing refresh_token' }) };
      tokenParams.grant_type    = 'refresh_token';
      tokenParams.refresh_token = refresh_token;
    }

    // Exchange with Xero
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.json();
      return {
        statusCode: tokenRes.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.error, description: err.error_description }),
      };
    }

    const tokens = await tokenRes.json();

    // Fetch tenant ID automatically after exchange
    let tenantId = null;
    let tenantName = null;
    if (action === 'exchange') {
      const connRes = await fetch('https://api.xero.com/connections', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
      });
      if (connRes.ok) {
        const connections = await connRes.json();
        if (connections.length > 0) {
          tenantId   = connections[0].tenantId;
          tenantName = connections[0].tenantName;
        }
      }
    }

    // Return tokens to browser — but NOT the client secret (it never leaves this function)
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in:    tokens.expires_in,
        tenantId,
        tenantName,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Token exchange failed', detail: err.message }),
    };
  }
};
