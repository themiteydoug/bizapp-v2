/**
 * Vercel Function: auth
 * Two-tier PIN authentication — staff and manager roles.
 *
 * Environment variables (set in Vercel dashboard):
 *   STAFF_PIN    — 4-digit PIN for staff access
 *   MANAGER_PIN  — 4-digit PIN for manager access
 *   APP_ORIGIN   — https://pcw.spottedcod.com.au
 */

const crypto = require('crypto');

// Sanitised, not used raw. A value pasted into the dashboard with a trailing
// newline looks identical there but is illegal in a header value: setHeader()
// throws ERR_INVALID_CHAR and this function 500s before running any of its own
// logic. That took out PIN login, sync and Xero at once. Also drops a trailing
// slash so origin comparisons stay stable.
const ALLOWED_ORIGIN = (process.env.APP_ORIGIN || 'https://pcw.spottedcod.com.au')
  .replace(/[\r\n\t]/g, '').trim().replace(/\/+$/, '');

// In-memory token store (cleared on cold start — acceptable for this use case)
const validTokens = new Map(); // token → { role, expiry }

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, pin, token } = req.body || {};

  // ── Login ──────────────────────────────────────
  if (action === 'login') {
    const staffPin   = process.env.STAFF_PIN || process.env.APP_PIN;
    const managerPin = process.env.MANAGER_PIN;

    if (!staffPin) {
      return res.status(500).json({ error: 'Auth not configured — set STAFF_PIN and MANAGER_PIN in Vercel environment variables' });
    }

    const inputHash = sha256(String(pin || ''));
    let role = null;

    // Check manager first (higher privilege)
    if (managerPin && inputHash === sha256(String(managerPin))) {
      role = 'manager';
    } else if (staffPin && inputHash === sha256(String(staffPin))) {
      role = 'staff';
    }

    if (!role) {
      await new Promise(r => setTimeout(r, 500)); // slow brute force
      return res.status(401).json({ error: 'Invalid PIN' });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
    validTokens.set(sessionToken, { role, expiry });

    return res.status(200).json({ token: sessionToken, expiry, role, managerConfigured: !!managerPin });
  }

  // ── Verify ─────────────────────────────────────
  if (action === 'verify') {
    const now = Date.now();
    const entry = validTokens.get(token);
    if (entry && entry.expiry > now) {
      return res.status(200).json({ valid: true, role: entry.role });
    }
    if (entry) validTokens.delete(token);
    return res.status(401).json({ valid: false });
  }

  return res.status(400).json({ error: 'Unknown action' });
};
