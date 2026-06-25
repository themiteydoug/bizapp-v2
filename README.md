# BizOps — Business Operations App v2

Mobile-first PWA for fast food business management.
Integrates Square (takings, timesheets, drawer report) and Xero (bills, payroll).

## What's in this version

- **Dashboard** — Live takings (ex GST), staff hours, cost analysis
- **Invoices** — Manual entry with required photo, supplier dropdown, GST calculator, sent to Xero as draft bill with photo attached
- **Daily cash rec** — Pulls Square drawer report (Starting Cash, Cash Sales, Paid In/Out, Expected in Drawer). Staff count Notes ($5+) and Coins ($2 and below) separately with +/− buttons
- **Weekly banking rec** — Mon–Sun cash count vs Square weekly totals
- **Timesheets** — Square hours split by day type → push to Xero
- **Staff mapping** — Fast Food Award penalty rates per employee

## Setup

### 1. Add credentials to js/config.js

```js
SQUARE: {
  ACCESS_TOKEN: 'sq0atp-...',
  LOCATION_ID:  'L...',
},
XERO: {
  CLIENT_ID:     '...',
  CLIENT_SECRET: '...',
  TENANT_ID:     '...',
},
```

Set `DEMO_MODE: false` when ready to go live.

### 2. Deploy (pick one)

**Vercel** — drag the bizapp-v2 folder to vercel.com/new  
**Netlify** — drag to app.netlify.com/drop  
**Vercel CLI** — `npx vercel` inside the folder

### 3. Install on iPhone

Open the deployed URL in Safari → Share → Add to Home Screen

### 4. Connect Xero

Tap ⚙ Settings → Connect Xero to run the OAuth login

### 5. Map staff

Staff tab → each employee → set their Xero payroll category for:
- Weekday rate
- Weekend penalty (Level 1: one rate covers Sat & Sun)
- Saturday / Sunday separately (Level 2+)
- Public holiday rate

## Fast Food Award — penalty rate logic

| Employee    | Saturday        | Sunday           | Public holiday |
|-------------|-----------------|------------------|----------------|
| Level 1     | Weekend penalty | ← Same as Sat    | PH rate        |
| Level 2+    | Sat penalty     | Sun penalty      | PH rate        |

## QLD public holidays

Built in for 2024, 2025, 2026. Brisbane Ekka toggle in Settings.
Update js/holidays.js each December for the following year.

## File structure

```
bizapp-v2/
├── index.html          App shell
├── manifest.json       PWA manifest (iPhone install)
├── sw.js               Service worker (offline)
├── vercel.json         Vercel deployment config
├── css/
│   └── app.css         Design system
└── js/
    ├── config.js       ← Add API keys here
    ├── store.js        Local data persistence
    ├── holidays.js     QLD public holiday calendar
    ├── api-square.js   Square API (takings, timesheets, drawer report)
    ├── api-xero.js     Xero API (bills, payroll push)
    ├── invoices.js     Invoice entry with photo
    ├── cash.js         Daily + weekly cash reconciliation
    ├── timesheets.js   Weekly timesheet review + Xero push
    ├── staff.js        Staff payroll mapping
    ├── dashboard.js    Dashboard metrics
    └── app.js          Navigation + app boot
```
