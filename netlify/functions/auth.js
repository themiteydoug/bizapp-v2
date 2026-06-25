/**
 * Netlify Function: auth
 * Two-tier PIN authentication — staff and manager roles.
 *
 * Environment variables (set in Netlify dashboard):
 *   STAFF_PIN    — 6-digit PIN for staff access
 *   MANAGER_PIN  — 6-digit PIN for manager access (more data, push to Xero)
 *   APP_ORIGIN   — https://spcod.netlify.app
 *
 * Legacy: APP_PIN is treated as STAFF_PIN if STAFF_PIN is not set.
 */

const crypto = require('crypto');

const ALLOWED_ORIGIN = process.env.APP_ORIGIN || 'https://spcod.netlify.app';

const corsHeaders = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// In-memory token store (cleared on cold start — acceptable for this use case)
const validTokens = new Map(); // token → { role, expiry }

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid request' }) }; }

  const { action, pin, token } = body;

  // ── Login ──────────────────────────────────────
  if (action === 'login') {
    const staffPin   = process.env.STAFF_PIN   || process.env.APP_PIN;
    const managerPin = process.env.MANAGER_PIN;

    if (!staffPin) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Auth not configured — set STAFF_PIN and MANAGER_PIN in Netlify environment variables' }) };
    }

    const inputHash = sha256(pin || '');
    let role = null;

    // Check manager first (higher privilege)
    if (managerPin && inputHash === sha256(managerPin)) {
      role = 'manager';
    } else if (staffPin && inputHash === sha256(staffPin)) {
      role = 'staff';
    }

    if (!role) {
      await new Promise(r => setTimeout(r, 500)); // slow brute force
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid PIN' }) };
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
    validTokens.set(sessionToken, { role, expiry });

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken, expiry, role }),
    };
  }

  // ── Verify ─────────────────────────────────────
  if (action === 'verify') {
    const now = Date.now();
    const entry = validTokens.get(token);
    if (entry && entry.expiry > now) {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ valid: true, role: entry.role }),
      };
    }
    if (entry) validTokens.delete(token);
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ valid: false }) };
  }

  return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Unknown action' }) };
};
