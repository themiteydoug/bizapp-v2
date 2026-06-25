# BizOps — Netlify Setup Guide

## Step 1: Set environment variables

Netlify Dashboard → Your Site → Site Settings → Environment Variables

### Square
| Variable | Value |
|----------|-------|
| `SQUARE_ACCESS_TOKEN` | Your Square production access token (developer.squareup.com) |
| `SQUARE_LOCATION_ID`  | Your Square location ID |
| `SQUARE_ENVIRONMENT`  | `production` |

### Xero
| Variable | Value |
|----------|-------|
| `XERO_CLIENT_ID`     | Your Xero app client ID (developer.xero.com) |
| `XERO_CLIENT_SECRET` | Your Xero app client secret |
| `XERO_REDIRECT_URI`  | `https://spcod.netlify.app/xero-callback.html` |
| `XERO_TENANT_ID`     | Your Xero tenant ID — see Step 3 below |

### Access control
| Variable | Value |
|----------|-------|
| `STAFF_PIN`   | 6-digit PIN for staff login (basic view — no financial data, no Xero push) |
| `MANAGER_PIN` | 6-digit PIN for manager login (full data, overhead analytics, push to Xero) |
| `APP_ORIGIN`  | `https://spcod.netlify.app` |

---

## Step 2: Enable live mode

In `js/config.js`, set:
```js
DEMO_MODE: false,
```

---

## Step 3: Get your Xero Tenant ID

1. Set `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, and `XERO_REDIRECT_URI` first
2. Deploy the app (Netlify → Deploys → Trigger deploy)
3. Open the app → ⚙ Settings → Connect Xero
4. Complete the Xero login — a popup opens, authorises, then shows your Tenant ID
5. Copy the Tenant ID into `XERO_TENANT_ID` in Netlify environment variables
6. Trigger another deploy for the tenant ID to take effect

---

## Step 4: Install on iPhone

Open the deployed URL in Safari → Share icon → Add to Home Screen

---

## Step 5: Map staff to Xero payroll

Staff tab → each employee → set Xero Employee ID and pay rate categories.
These must match the earnings rate names in your Xero payroll settings exactly.

---

## What each role sees

### Staff (STAFF_PIN)
- Today's takings and hours
- Cash reconciliation
- Timesheets — view only (cannot push to Xero)
- Invoice entry (snap photo, enter details)

### Manager (MANAGER_PIN)
- Everything staff sees, plus:
- Full cost breakdown (labour, COGS, overheads)
- Invoices due from Xero
- 12-week overhead average (ex wages and super) from Xero P&L
- Push timesheets to Xero at end of week
- Staff pay rate mapping

---

## Security notes

- `XERO_CLIENT_SECRET` and `SQUARE_ACCESS_TOKEN` never leave the server
- `XERO_CLIENT_ID` is exposed to the browser (it's not a secret — this is standard OAuth)
- Staff PIN and Manager PIN are compared server-side with SHA-256 hash and constant-time comparison
- Xero access tokens are stored in the browser's `localStorage` (standard for PWAs)
- Tokens expire after 30 minutes and are automatically refreshed using the refresh token

---

## Rotating credentials

To change a PIN or API key: update the Netlify environment variable → trigger a new deploy.
No code changes needed.
