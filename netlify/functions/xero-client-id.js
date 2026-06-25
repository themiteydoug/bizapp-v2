/**
 * Netlify Function: xero-client-id
 * Returns the Xero OAuth client_id to the browser.
 * The client_id is NOT a secret — it's safe to expose.
 * The client_secret stays server-side in xero-auth.js.
 *
 * Environment variables required:
 *   XERO_CLIENT_ID  — your Xero app client ID
 *   APP_ORIGIN      — https://spcod.netlify.app
 */

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://spcod.netlify.app';

const corsHeaders = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'XERO_CLIENT_ID not configured in Netlify environment variables' }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  };
};
