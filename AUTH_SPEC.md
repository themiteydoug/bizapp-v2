# PCW — Device-Code Login: Build Spec

A spec for replacing the shared PIN with a proper login: an **owner account**
plus **Square-style device codes** so staff devices are set up once and stay
signed in. Draft for review — not built yet. Builds on the Upstash KV store
already in place.

---

## Goal

- One **owner** signs up (email + password), connects Square + Xero.
- Owner generates **device codes** (tagged Manager or Staff).
- Any new device redeems a code **once** and is then **fully operational and
  stays signed in** — no account login, no repeated PINs.
- Owner can **see and revoke** devices (lost phone → kill its access).
- Easy to hand a tablet/phone to staff without sharing the owner password.

This is a simplified, single-business version of the roadmap's "Accounts &
sign-in" item. It does **not** yet do multi-business or Google/Apple SSO.

---

## User flows

### First run (owner)
1. App opens → "Welcome to PCW" → **Create account** (email + password).
   - Allowed only when **no account exists yet** (first run claims ownership).
2. Owner lands in the app as **Manager**, connects Square + Xero in Settings.

### Returning owner
- Login screen → **Sign in** (email + password) → Manager session.

### Adding a staff/manager device
1. Owner opens **Settings → Devices → Add device**, picks a role
   (Manager/Staff) and an optional label ("Shop iPad").
2. App shows a **code** (e.g. `PCW-4F9K2`), valid to redeem for 24h, single use.
3. On the new device: app opens → **Enter device code** → type the code →
   device is paired, signed in with that role, and **stays signed in**.

### Revoking
- **Settings → Devices** lists paired devices (label, role, last seen).
  Owner taps **Revoke** → that device is signed out on its next check.

---

## Data model (Upstash KV)

New keys (alongside the existing `pcw:*` data keys):

- `pcw:auth:account` — STRING JSON
  `{ email, passSalt, passHash, createdAt }` (single owner for v1).
- `pcw:auth:devices` — HASH `deviceId -> { id, label, role, createdAt, lastSeen, revoked:false }`
- `pcw:auth:codes` — HASH `code -> { code, role, label, createdAt, expiresAt, status:'pending'|'used', deviceId? }`
- Signing secret: **env var `AUTH_SIGNING_SECRET`** (preferred — stable, not in
  code). If unset, generate once and store in `pcw:auth:secret`.

> Reuses the existing `/api/data` Redis instance — no new infra.

---

## Tokens & security

- **Session token** = `base64url(payload) + "." + HMAC_SHA256(payload, secret)`.
  Payload: `{ t:'device'|'owner', deviceId, role, iat }`. Compact, JWT-like,
  no library needed.
- **Persistent**: stored in `localStorage` (`pcw_session`) so devices stay
  signed in across app closes (this replaces the sessionStorage PIN behaviour).
- **Passwords**: hashed with Node's built-in `crypto.scrypt` + per-account salt,
  compared with `crypto.timingSafeEqual`. Never stored or logged in plain text.
  **No new dependencies** — all standard library.
- **Revocation**: tokens aren't individually expired; instead the device record
  carries `revoked`. The app validates its token on boot and every few minutes
  via `/api/auth?action=session`; a revoked device is signed out then. (Trade-off:
  revocation takes effect within minutes / next open, not instantly. Acceptable
  for v1; can tighten later.)
- **Origin check** retained on all endpoints (as today).
- **Brute-force**: basic per-email login attempt counter in KV (e.g. lock 15 min
  after 10 failures). Lightweight, v1-optional.
- HTTPS enforced by Vercel.

---

## Endpoints

Extend `api/auth.js` (or a new `api/account.js`). All POST, origin-checked,
JSON. Owner-only actions require a valid owner token in an `Authorization` header.

| Action | Auth | Body | Returns |
|---|---|---|---|
| `signup` | none (only if no account) | `email, password` | owner token |
| `login` | none | `email, password` | owner token |
| `session` | any token | — | `{ valid, role, revoked }` |
| `gencode` | owner | `role, label?` | `{ code, expiresAt }` |
| `redeem` | none | `code, deviceLabel?` | device token + role |
| `devices` | owner | — | list of devices |
| `revoke` | owner | `deviceId` | `{ ok }` |

### Protecting the data/proxy endpoints
- v1: `/api/data` (and ideally `xero-proxy`, `square-proxy`, `scan-invoice`)
  verify the **token signature** on each call (cheap, no KV hit). Revocation is
  enforced via the periodic `session` check on the client.
- v2 hardening: validate `revoked` server-side per sensitive write.

---

## Client changes

- **`js/auth.js`** — replace the PIN keypad with:
  - **Create account** (shown only when server reports no account yet),
  - **Sign in** (email + password),
  - **Enter device code**.
  - Persist `pcw_session` in localStorage; expose `getRole()` from the token.
  - On boot: call `session` to confirm valid/not-revoked → else show login.
- **`js/app.js`** — role UI already keys off `Auth.isManager()`; just reads the
  token's role now. Add a **Devices** panel in Settings (owner only):
  generate codes, list devices, revoke.
- **Send the token** with requests to protected endpoints (`Authorization`
  header) from `Sync` and the API proxies.
- Retire `MANAGER_PIN` / `STAFF_PIN` env vars (optionally keep as a temporary
  break-glass during rollout).

---

## Roles

- **Owner** → Manager app role (full access; only one who can manage devices &
  connect Square/Xero).
- **Device code role** → `manager` or `staff`, drives the same `role-manager` /
  `role-staff` UI already in place.
- (Future: distinguish "owner" from additional "managers" with their own logins.)

---

## Rollout / migration

1. Build entirely on the feature branch; **don't merge to `main`** until you've
   tested it — production keeps the PIN login meanwhile.
2. On switch-over: first launch prompts **Create account**; owner re-connects
   Square/Xero if needed (tokens are per-device today).
3. Bump the service worker; existing devices show the new login on next load.
4. Optional: keep PIN as a hidden fallback for one release in case of issues.

---

## Open decisions (your call before build)

1. **Device codes single-use vs reusable.** Recommend **single-use, 24h expiry**
   (one code → one device) — cleaner and safer. Reusable codes are handier but
   riskier if leaked.
2. **Optional PIN / Face-ID lock on top** of a signed-in device, for shared
   tablets. Recommend **available but off by default** (you wanted easy sharing).
3. **Code format.** Recommend `PCW-XXXXX` (5 chars, no ambiguous 0/O/1/I).
4. **One owner account vs multiple managers with their own logins.** Recommend
   **single owner for v1**; multiple logins is a later (multi-tenant) step.

---

## Effort & risk

- **Size:** the largest piece since the sync layer — several endpoints + an
  auth rewrite + a Devices UI. Not a quick add, but self-contained and low-risk
  to production because it ships on the branch first.
- **No new dependencies / infra** — uses existing Upstash KV and Node's `crypto`.
- **Reversible:** keep PIN fallback for one release.

---

## Explicitly out of scope (stays in ROADMAP)

- Multiple businesses (multi-tenancy), Google/Apple SSO.
- Per-business branding pulled from accounts.
- Instant/realtime backend (still 15s polling).
- Server-side storage of Square/Xero tokens (still per-device OAuth today).
