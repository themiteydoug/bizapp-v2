# BizOps — Deployment & Setup Guide

BizOps is a **Progressive Web App (PWA)**: a website that installs to your phone's
home screen and runs full-screen like a native app. It's hosted on **Vercel**, and
talks to **Square** (sales/timesheets), **Xero** (accounting/payroll), and
**Anthropic/Claude** (invoice photo reading) through small server-side functions in
the `api/` folder. Your secret keys live only in Vercel — never in the browser.

- **Production URL:** https://bizapp-v2.vercel.app
- **Hosting:** Vercel (auto-deploys the `main` branch)
- **Source of truth:** the `main` branch — every push to it triggers a new deploy

---

## 1. Installing it as an app on your phone

You don't download it from an app store — you "Add to Home Screen" from the browser.
After that it has its own icon and opens full-screen with no address bar.

### iPhone / iPad (Safari)
1. Open **https://bizapp-v2.vercel.app** in **Safari** (must be Safari, not Chrome, for install on iOS).
2. Tap the **Share** button (square with an up-arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**. The BizOps icon appears on your home screen.

### Android (Chrome)
1. Open **https://bizapp-v2.vercel.app** in **Chrome**.
2. Tap the **⋮** menu (top-right).
3. Tap **Install app** (or **Add to Home screen**).
4. Confirm. The icon appears in your app drawer.

### Desktop (Chrome / Edge)
1. Open the URL.
2. Click the **install icon** in the address bar (a monitor/▽ symbol), or **⋮ → Install BizOps**.

> **Notes**
> - Each device installs independently. Logins and the Xero connection are stored
>   per-device, so you sign in once on each phone.
> - Updates are automatic — next time you open the app while online, it pulls the
>   latest version. No reinstalling.
> - The home-screen icon is a green "B". (iOS prefers a PNG icon; ours is an SVG,
>   so on some iPhones the icon may show a letter/placeholder instead of the green
>   "B" — purely cosmetic, doesn't affect anything.)

---

## 2. First-time Vercel setup (environment variables)

These are the secret values the app needs. Set them in:

**Vercel → your `bizapp-v2` project → Settings → Environment Variables.**

Tick **Production** (ticking all three — Production, Preview, Development — is fine).

> ⚠️ **After adding or changing ANY variable you must redeploy** — env-var changes
> only apply to *new* deployments. Go to **Deployments → newest → ⋯ → Redeploy**.

### Required variables

| Variable | What it is | Where to get it |
|---|---|---|
| `APP_ORIGIN` | Your app's exact URL, no trailing slash | `https://bizapp-v2.vercel.app` |
| `MANAGER_PIN` | PIN for manager login | You choose (e.g. a 4–6 digit number) |
| `STAFF_PIN` | PIN for staff login | You choose |
| `SQUARE_ACCESS_TOKEN` | Square API token | Square Developer Dashboard → your app → **Production** access token |
| `SQUARE_LOCATION_ID` | Your Square location | Square Dashboard → Locations (or the Locations API) |
| `SQUARE_ENVIRONMENT` | `production` or `sandbox` | Set to `production` for live data |
| `XERO_CLIENT_ID` | Xero app client ID | Xero Developer portal → your app |
| `XERO_CLIENT_SECRET` | Xero app secret | Xero Developer portal → your app |
| `XERO_TENANT_ID` | Your Xero organisation ID | The org you connect during the first Xero login |
| `XERO_REDIRECT_URI` | OAuth callback URL | `https://bizapp-v2.vercel.app/xero-callback.html` |
| `ANTHROPIC_API_KEY` | For invoice photo reading (OCR) | console.anthropic.com → API Keys (see §5) |

> `APP_PIN` is accepted as a legacy fallback for `STAFF_PIN` — you don't need both.

---

## 3. Square setup

1. Go to **developer.squareup.com** → Dashboard → your application.
2. Switch to **Production** (top of the page), and copy the **Production Access Token**
   → set as `SQUARE_ACCESS_TOKEN`.
3. Find your **Location ID** (Square Dashboard → Account & Settings → Business →
   Locations, or via the API) → set as `SQUARE_LOCATION_ID`.
4. Set `SQUARE_ENVIRONMENT` = `production`.
5. Redeploy.

---

## 4. Xero setup

1. Go to **developer.xero.com** → **My Apps** → create/open your app.
2. App type: **Web app**.
3. Set the **Redirect URI** to **exactly**:
   ```
   https://bizapp-v2.vercel.app/xero-callback.html
   ```
4. Copy **Client ID** → `XERO_CLIENT_ID`, generate a **Client Secret** → `XERO_CLIENT_SECRET`.
5. Also set `XERO_REDIRECT_URI` to the same callback URL above.
6. The app requests these scopes (already configured in `js/config.js`):
   `openid profile email offline_access accounting.contacts accounting.invoices`
   `accounting.reports.profitandloss.read payroll.employees.read payroll.settings.read payroll.timesheets`
7. Redeploy, then in the app: **Settings → Connect Xero**, log in, and pick your
   organisation. The org you authorise determines `XERO_TENANT_ID` — set that env var
   to that organisation's tenant ID.

> **Staying connected:** once connected, the app refreshes its Xero token
> automatically. As long as you open the app at least once every ~60 days you stay
> connected. After 60 days idle, or on a new device, you reconnect once.

---

## 5. Anthropic key (invoice OCR)

OCR reads the supplier, total, GST and date straight off an invoice photo. It's
**pay-as-you-go** (no subscription) and very cheap — a fraction of a cent per scan.

1. Go to **console.anthropic.com** and sign in (separate account from Claude.ai chat).
2. **Billing** → add a card and buy a little credit (**$5 lasts thousands of scans**).
   It will not work on a $0 balance.
3. **Billing → usage limits** → set a monthly cap (e.g. $10) so there are no surprises.
4. **API Keys → Create Key**, name it `bizops-vercel`, copy the `sk-ant-api03-…` value
   (shown only once).
5. Set it as `ANTHROPIC_API_KEY` in Vercel and **redeploy**.

> Don't paste the key anywhere in the app UI or share it — it spends your credit.
> It belongs only in Vercel's server environment.
> To turn OCR off entirely (zero AI cost), use **Settings → Invoices → Auto-read
> invoice details → Off** and enter invoices manually.

**Verify it's live:** open `https://bizapp-v2.vercel.app/api/scan-invoice` in a browser.
Seeing `{"error":"Method not allowed"}` means the function is running and the key is
configured (it just wants a POST, not a plain visit).

---

## 6. In-app settings (Settings ⚙ → Invoices)

| Setting | Default | What it does |
|---|---|---|
| **Send invoices to Xero** | On | On = creates a draft bill in Xero (and attaches the photo). **Off** = records the invoice locally for cost reporting only — use this if your bills already reach Xero another way (e.g. email forwarding) so you don't get duplicates. |
| **Auto-read invoice details** | On | On = reads details from the photo via AI (small per-scan cost). Off = manual entry, no AI cost. |

There's also a **Royal Queensland Show (Ekka)** holiday toggle under Public Holidays.

> For Spotted Cod's current setup (bills auto-forward to Xero by email):
> **Send invoices to Xero = Off**, **Auto-read = On**.

---

## 7. How updates / deploys work

- The live site serves the **`main`** branch.
- Pushing to `main` automatically triggers a Vercel build and deploy (~30–60s).
- The app uses a "network-first" service worker, so a refresh while online always
  pulls the newest version. If you ever suspect a stale version, fully close and
  reopen the app.

---

## 8. Moving to your own domain (e.g. for selling it)

You can keep hosting on Vercel and point your own domain at it (e.g. a domain you
own at Crazy Domains). **Don't move the app to standard web hosting** — the `api/`
functions need Vercel's serverless runtime to run and to keep your keys secret.

1. **Vercel → project → Settings → Domains →** add your domain (e.g. `bizops.yourbiz.com.au`).
2. Vercel gives you a DNS record (usually a CNAME). Add it in your domain registrar's
   DNS settings.
3. **Then update these so logins/OCR keep working on the new URL:**
   - `APP_ORIGIN` env var → your new domain (no trailing slash).
   - `XERO_REDIRECT_URI` env var → `https://yourdomain/xero-callback.html`.
   - In **`js/config.js`** → `XERO.REDIRECT_URI` → the same new callback URL.
   - In the **Xero developer portal** → add the new callback URL to the app's
     allowed Redirect URIs.
   - **Redeploy.**
4. Always use the canonical domain — Vercel *preview* URLs
   (`…-projects.vercel.app`) won't match `APP_ORIGIN`, so OCR will be blocked there
   by design.

> **Selling to multiple businesses** is a bigger step ("multi-tenancy"): each
> business needs its own Square/Xero credentials, PINs, and isolated login instead
> of the single set of env vars above. That's a known, staged piece of work — worth
> planning before onboarding a second business.

---

## 9. Quick troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| OCR: "couldn't read this invoice" | Check `ANTHROPIC_API_KEY` is set **and** the account has credit; redeploy after setting. |
| OCR "Forbidden" | You're on a Vercel preview URL, or `APP_ORIGIN` doesn't match. Use `bizapp-v2.vercel.app`. |
| `FUNCTION_INVOCATION_FAILED` | A server function crashed — check Vercel → Deployments → Functions logs. |
| Xero actions fail / ask to reconnect | Token expired (60+ days idle) or scopes changed — **Settings → Connect Xero** again. |
| Square data missing/zero | `SQUARE_ENVIRONMENT` not `production`, or wrong `SQUARE_LOCATION_ID`. |
| App shows an old version | Fully close and reopen; it's network-first so a fresh open updates it. |

---

*Generated as a setup reference for the BizOps PWA.*
