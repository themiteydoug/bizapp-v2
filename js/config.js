/**
 * BizOps Configuration
 * ====================
 * This file is SAFE to deploy — it contains NO secrets.
 * All credentials live in Netlify environment variables (Site Settings → Environment Variables).
 *
 * Required Netlify environment variables:
 *   SQUARE_ACCESS_TOKEN   — Square production access token
 *   SQUARE_LOCATION_ID    — Square location ID
 *   SQUARE_ENVIRONMENT    — production
 *   XERO_CLIENT_ID        — Xero app client ID (also returned by xero-client-id function)
 *   XERO_CLIENT_SECRET    — Xero app client secret (never leaves server)
 *   XERO_REDIRECT_URI     — https://spcod.netlify.app/xero-callback.html
 *   XERO_TENANT_ID        — Xero tenant ID (fetched automatically on first login)
 *   STAFF_PIN             — 6-digit PIN for staff access
 *   MANAGER_PIN           — 6-digit PIN for manager access
 *   APP_ORIGIN            — https://spcod.netlify.app
 */

const CONFIG = {

  // ── Netlify Function endpoints ───────────────
  API: {
    SQUARE:          '/.netlify/functions/square-proxy',
    XERO:            '/.netlify/functions/xero-proxy',
    XERO_AUTH:       '/.netlify/functions/xero-auth',
    XERO_CLIENT_ID:  '/.netlify/functions/xero-client-id',
    AUTH:            '/.netlify/functions/auth',
  },

  // ── Xero OAuth (public values only) ─────────
  XERO: {
    REDIRECT_URI: 'https://spcod.netlify.app/xero-callback.html',
    SCOPES: 'openid profile email offline_access accounting.contacts.read accounting.invoices.read accounting.reports.profitandloss.read payroll.employees.read payroll.timesheets',
  },

  // ── Business settings ────────────────────────
  BUSINESS: {
    NAME:          'My Business',
    STATE:         'QLD',
    TIMEZONE:      'Australia/Brisbane',
    CURRENCY:      'AUD',
    FLOAT_DEFAULT: 300,
    AWARD:         'Fast Food Industry Award',
    WEEK_START:    1, // Monday
  },

  // ── Feature flags ────────────────────────────
  FEATURES: {
    DEMO_MODE: false,  // Set to true to use demo data without API keys
  },

};

Object.freeze(CONFIG);
Object.freeze(CONFIG.API);
Object.freeze(CONFIG.XERO);
Object.freeze(CONFIG.BUSINESS);
Object.freeze(CONFIG.FEATURES);
