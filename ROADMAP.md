# PCW — Future Development Roadmap

Notes for turning PCW from a **single-business app** (Spotted Cod) into a
**multi-business product** you could sell to others. Written as a planning
reference — nothing here is built yet. Captured 27 Jun 2026.

---

## Where the app is today (the starting point)

Understanding the current design makes the roadmap make sense:

- **One business only.** All secrets live in **Vercel environment variables**:
  `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `XERO_CLIENT_ID/SECRET`,
  `XERO_TENANT_ID`, `MANAGER_PIN`, `STAFF_PIN`, `ANTHROPIC_API_KEY`.
- **Login = a shared PIN** checked against those env vars. There are no user
  accounts, no database.
- **Square** uses a *static access token* (not a login) — fine for one business,
  but it can't onboard others.
- **Xero** already uses *OAuth* (each device authorises and the token is stored
  in that device's `localStorage`), **but** the organisation is pinned by the
  `XERO_TENANT_ID` env var — so it's still hard-wired to one org.
- **All app data** (invoices, settings, timesheet edits, the logo reference)
  lives in the browser's `localStorage`, per device. Nothing is stored centrally.

**The single change that unlocks items 1–4 below is the same one:** introduce a
**backend with a database and real user accounts** ("multi-tenancy"). Everything
else hangs off that.

---

## Database strategy — revisit before scaling

The first live-data backend is **Vercel KV / Upstash Redis** (key-value) with the
app polling every ~15s — chosen for speed of delivery. It's near-live, not
instant. Before going to a real product, reassess the datastore:

- **Instant updates feel more professional.** Polling has a visible lag; a
  realtime database pushes changes the moment they happen. For a paid product,
  instant is the right bar.
- **Recommended target: Postgres with realtime** — e.g. **Supabase** (Postgres +
  realtime subscriptions + auth/SSO in one), or **Neon** (Postgres) paired with a
  realtime layer. Postgres also gives proper relational structure for
  multi-business data, reporting, and migrations — things Redis isn't built for.
- **Other contenders seen in Vercel's Marketplace:** Neon (serverless Postgres),
  Supabase, official Redis, Convex (reactive/realtime), Nile (Postgres for B2B
  multi-tenant). Convex and Supabase are the most "instant" out of the box.
- **Migration path:** the app already funnels all reads/writes through a small
  `/api/data` layer and `js/sync.js`. Swapping Redis-polling for a realtime
  Postgres backend means rewriting those two pieces, not the whole app — the rest
  of the code keeps using `Store` as-is.

> Bottom line: KV/Redis polling is the pragmatic start for one business. When you
> commit to selling it, move to **realtime Postgres (Supabase/Neon/Convex)** for
> instant updates + the multi-tenant foundation below.

### Database capacity / paid tier

The live store currently runs on **Upstash for Redis (Free tier)**, connected via
Vercel. Free limits to watch:

- **1 database per account**, ~**256 MB** storage, ~**10,000 commands/day**.
- Eviction is **off** (deliberately) so invoices/cash are never auto-deleted —
  which also means if the 256 MB cap is ever hit, *writes fail* rather than data
  silently dropping. Plenty for one shop, but a real ceiling at scale.

When to upgrade / change:

- **One busy shop, long history + photos:** invoice photos are stored as data in
  localStorage and (currently) not in Redis, so Redis stays small — but heavy use
  could still approach the daily command limit with the 15s polling. Move to
  Upstash **Pay-as-you-go / Pro** (a few $/month) if you see throttling.
- **Multiple businesses (selling it):** the Free "1 database" cap is the blocker.
  Either go paid Upstash with per-tenant key namespacing, or (preferred) move to
  the **realtime Postgres** option above, which is built for multi-tenant scale
  and gives instant updates at the same time.
- **Polling cost:** every device polls every 15s = ~5,760 reads/device/day. A
  handful of devices fits Free; many devices/businesses do not — another reason
  realtime push (no polling) is the right long-term move.

## The foundational step: multi-tenancy

To support more than one business you need a place to store *per-business* data
on a server (not in env vars or one phone's localStorage). That means:

1. **A database** (e.g. Postgres via Supabase/Neon, or Firebase). It holds:
   - Businesses (tenants), users, and which users belong to which business + role.
   - Each business's **Square** and **Xero** tokens (encrypted).
   - Each business's settings, logo, PINs/roles, and cached app data.
2. **A small backend / API layer.** The current `api/` functions already are a
   backend — they'd grow to read tokens from the database *per logged-in business*
   instead of from a single env var.
3. **Token security.** Right now Xero tokens sit in `localStorage` (acceptable for
   one owner-operated business). For a product, OAuth tokens should live
   **server-side, encrypted**, and the browser should only ever hold a session —
   never the raw API tokens. This is the "Upsheets maintains the logins" model
   you described.

> Rough effort: this is the big one — days-to-weeks of work, not hours. But it's
> standard SaaS plumbing, well-trodden, and once it exists, items 1–4 become
> straightforward features rather than rewrites.

---

## 1. How another business connects **Square** on first run

Today Square is a static token in env vars — that won't work for other people.
The product answer is **Square OAuth** (the same pattern Xero already uses, and
what Upsheets does):

1. You register **one** PCW app in the Square Developer Dashboard (your app's
   client ID/secret — not the merchant's).
2. On first run, the new business taps **"Connect Square"** and is sent to
   Square's login/consent screen.
3. Square redirects back with an authorisation code; the backend exchanges it for
   that merchant's **access token + refresh token**, and stores them (encrypted)
   against their business in the database.
4. The app asks which **location** to use (Square returns the list) and saves it.
5. Tokens auto-refresh server-side, so they stay connected — no re-login.

**Result:** each business connects their own Square account once; you never
handle their token by hand.

---

## 2. How another business connects **Xero** on first run

Good news — **the OAuth flow already exists**; it just needs two changes to be
multi-business:

1. **Stop pinning the org.** Remove the `XERO_TENANT_ID` env var. After a business
   authorises, call Xero's *connections* endpoint, let them pick their
   organisation, and store **that tenant ID** against their business in the
   database.
2. **Move token storage server-side.** Instead of saving the Xero token in the
   browser's `localStorage`, store it (encrypted) in the database per business,
   and refresh it server-side. The browser keeps only a login session.

The user experience is identical to now ("Connect Xero" → log in → pick org →
done), but it works for any number of businesses and the connection is
centrally maintained — again, the Upsheets model.

> Both #1 and #2 boil down to: *app-level credentials live in your config;
> each business's tokens live in the database, keyed to their account.*

---

## 3. Accounts & sign-in with Google / Apple / email

Replace the shared PIN with real accounts so each person logs into their own
business. Practical path:

- Use a managed **auth provider** — e.g. **Supabase Auth**, **Auth0**, **Clerk**,
  or **Firebase Auth** — which give **Sign in with Google / Apple / email** out of
  the box (Apple sign-in is effectively required for iOS app-store-style UX).
- On first sign-in, a user either **creates a business** (becomes its manager/owner)
  or **joins one** via an invite from the owner.
- **Roles** (manager/staff) move from the env-var PIN into the user record.
- **Keep a quick PIN/biometric unlock** on top for shift use: staff sign in with
  the account once on a device, then a fast PIN or Face ID for day-to-day — best
  of both (the secure account + the fast counter login you have now).

> This also retires `MANAGER_PIN` / `STAFF_PIN` env vars in favour of per-user
> roles in the database.

---

## 4. Per-business logo & branding in setup

Once businesses and a database exist, branding becomes a simple feature:

- **Setup wizard step** (and a **Settings menu** option) to **upload a logo**.
- The backend stores the image (e.g. object storage / Supabase Storage) and
  generates the icon sizes automatically — exactly what we did by hand for the
  fish (192/512/180/maskable), but server-side on upload.
- The app then shows that business's logo on the **login screen** and references
  it from a **per-business manifest** so it becomes their **home-screen icon**.

> One real constraint to note: a PWA's installed home-screen icon is set from the
> manifest **at install time**. For truly per-business icons you'd serve a
> per-tenant manifest (e.g. `/b/<business>/manifest.json`), and each business
> installs *their* branded URL. Doable, just a design choice to make early.
> The login-screen logo and in-app branding update instantly with no such caveat.

---

## 5. Other items flagged earlier (parked for later)

- **Custom domain** for the live app (e.g. `pcw.yourbiz.com.au`). Steps are
  already written in `DEPLOYMENT.md` §8 (Vercel domain + DNS + update
  `APP_ORIGIN`, `XERO_REDIRECT_URI`, `js/config.js`, Xero portal).
- **iOS HEIC photos.** If an iPhone ever saves an invoice photo as HEIC, OCR skips
  it. We already re-encode to JPEG via canvas on upload, which covers most cases;
  a dedicated HEIC fallback could be added if it ever shows up in practice.
- **AI cost controls for a product.** OCR is pay-per-use on your Anthropic key.
  For multiple businesses: set a usage cap (console.anthropic.com → Billing →
  limits) and fold the per-scan cost into a subscription price. Optionally meter
  scans per business.
- **PIN session length.** Currently re-prompts on every full app close (you chose
  this). Could become a per-business setting (e.g. "stay signed in 7/30 days")
  once accounts exist.
- **"Send invoices to Xero" as a setup question + server-stored setting.** Some
  owners (like Spotted Cod) already auto-forward bills to Xero by email and must
  NOT have the app create duplicate drafts; others will want the app to push them.
  Make this an explicit **question in the setup wizard**, owned by the **manager**.
  Today it's a per-device localStorage flag (now hidden from staff), so it does
  **not** sync across devices — meaning a staff member entering invoices on their
  own device could still push to Xero against the manager's choice. The fix is to
  store this (and OCR on/off) **server-side per business** so the manager sets it
  once and every device — staff included — obeys it. Depends on the database/
  multi-tenancy step. *Interim option without the backend: a deployment-level
  default via an env var so all devices share the owner's choice.*
- **PNG app icon polish.** Done for the fish; for a product, auto-generate from
  each business's uploaded logo (see #4).
- **Subscription / billing** (if selling): a Stripe-style plan layer — out of
  scope today but the natural commercial step after multi-tenancy.

---

## Suggested order of work (when you're ready)

1. **Multi-tenancy foundation** — database + backend that reads per-business
   tokens. (Unlocks everything.)
2. **Accounts & SSO** (#3) — Google/Apple/email login, roles, invites.
3. **Square OAuth** (#1) and **Xero per-tenant tokens** (#2) — self-serve connect.
4. **Branding upload** (#4) — logo → login + icons.
5. **Billing & polish** — subscriptions, usage caps, custom domains per business.

Each builds on the last, and after step 1 you could onboard a second test
business even before the rest is polished.
