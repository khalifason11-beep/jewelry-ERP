# Deployment behind a reverse proxy (Render or similar)

This guide covers a production deployment where the app runs behind a managed reverse proxy or load
balancer that terminates HTTPS, for example a Render Web Service with a Render PostgreSQL database.
The app is a single Node.js service: the API serves the built React app too, so no separate static
site is needed.

> Production mode refuses to start while the configuration is unsafe (see D-1a-10 in
> [decisions.md](decisions.md)). If the service does not come up, read the start-up log first: it lists
> every problem it found.

## 1. Services

| Render resource | Settings |
|---|---|
| PostgreSQL | Any plan. Use the **Internal Database URL** for the web service, so traffic stays on Render's private network. |
| Web Service | Runtime **Node**, region the same as the database. |
| Build command | `npm ci --include=dev && npm run build` (the start command runs TypeScript through `tsx`, a dev dependency, so dev dependencies must be installed) |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Instances | **1** for now. The per-IP sign-in throttle and the login counters for unknown usernames are kept in process memory, and each instance keeps its own settings cache for up to 5 s. See "Remaining limits" below. |

## 2. Environment variables

| Variable | Value on Render | Why |
|---|---|---|
| `APP_MODE` | `production` | Turns off demo data, demo accounts, the Hasad simulator and "Reset demo data", and turns on the start-up refusals. |
| `DATABASE_URL` | Render's **Internal Database URL** (`postgresql://user:password@host/db`) | Required in production; embedded PGlite is refused. Render generates a strong password. Never reuse `postgres`, `password`, `admin`, `root`, `changeme`, `secret` or `123456`: they are refused. |
| `APP_ORIGIN` | `https://<your-service>.onrender.com`, or your custom domain, e.g. `https://erp.example.com` | Exact origin the browser uses (scheme + host, no trailing slash, no path). Must be `https://`. State-changing requests from any other origin are rejected (CSRF defence). If you add a custom domain later, update this value. |
| `TRUST_PROXY` | `1` to start with, then **verify** (section 4) | Number of proxy hops in front of the app. It decides which `X-Forwarded-For` entry becomes the client IP used in the audit log, the sessions list and the per-IP sign-in throttle. Unset means "no proxy": all users then appear with the proxy's IP. |
| `COOKIE_SECURE` | leave **unset** (defaults to `true` in production) | The session cookie is `__Host-jerp_session`: `Secure`, `HttpOnly`, `SameSite=Lax`. `false` is refused in production. |
| `LOG_LEVEL` | `info` | `warn` or `error` to reduce volume, `debug` only while diagnosing. Logs never contain bodies, query strings, cookies or passwords. |
| `NODE_VERSION` | `22` | Node 20 or newer is required; 22 is what the project is tested on. |
| `PORT` | **do not set** | Render provides it; the app reads it. |

Secrets: the only secret is the database password inside `DATABASE_URL`. Keep it in Render's
environment settings (or an Environment Group), never in the repository. The app needs no signing key:
CSRF tokens and session ids are random values stored in the database. Rotating the database password
means updating `DATABASE_URL` and redeploying; all sessions survive because they live in the database.

Not used in production: `PGLITE_DIR` (embedded demo database only).

## 3. First start

1. Create the database and the web service with the variables above. Deploy. Migrations run
   automatically at start-up (forward-only; they never drop data).
2. Open the service's **Shell** tab and create the first General Manager and the branches:

   ```bash
   npm run bootstrap -w @jerp/backend -- --username gm.owner --full-name "Owner Name" --full-name-ar "اسم المالك" \
     --branch "KRT:Khartoum Branch:فرع الخرطوم:Khartoum"
   ```

   It prints a one-time password that must be changed at the first sign-in, and refuses to run again once a
   General Manager exists. Further branches can be added later from **Branches → New branch** (GM only).
3. Sign in as the GM, change the password, then open **Settings** and set the company names, currency
   labels, invoice footer and logo. Enable Hasad Gold per branch only when the Hasad integration is live.

### Operator console (shell access only)

Two recovery actions exist for the case where nobody can sign in. They are **not** reachable over HTTP;
you need the Render Shell (or SSH) for the service:

```bash
# Lift a sign-in lock (any user)
npm run ops -w @jerp/backend -- unlock --username gm.owner

# Reset the General Manager's password (GM accounts only); prints a one-time password,
# ends all of that user's sessions and forces a password change at the next sign-in
npm run ops -w @jerp/backend -- reset-gm-password --username gm.owner
```

Both refuse to run unless `APP_MODE=production` and the production configuration is safe (pass
`--allow-non-production` only on purpose, e.g. against a staging copy). Each action is written to the
audit log as actor **System (operator-cli)** with the server host name and the OS user.

## 4. Verify that real client IPs reach the app

Do this once after the first deploy, and again after any change to the proxy, CDN or custom domain.

**a. Your own IP appears.**

1. On your phone, turn Wi-Fi **off** (mobile data), open a "what is my IP" page and note the address.
2. Sign in to the ERP from the phone.
3. On a computer, sign in as the GM and open **Active sessions**. The phone's session must show the
   address from step 1. Also check **Audit log**: the `LOGIN` entry must show the same IP.
4. If the address shown is a private one (`10.x`, `172.16–31.x`, `192.168.x`) or belongs to the hosting
   provider, the app is trusting **too few** hops: raise `TRUST_PROXY` by one, redeploy and repeat.

**b. A forged header is ignored.** From a computer, send a failed sign-in with a made-up forwarded address:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://erp.example.com/api/auth/login \
  -H 'Origin: https://erp.example.com' -H 'Content-Type: application/json' \
  -H 'X-Forwarded-For: 203.0.113.77' \
  -d '{"username":"gm.owner","password":"wrong-password"}'
```

It answers `401`. In **Audit log**, the matching `LOGIN_FAILED` entry must show **your computer's real IP**,
never `203.0.113.77`. If it shows `203.0.113.77`, the app is trusting **too many** hops: lower
`TRUST_PROXY` by one and redeploy. (This failed attempt counts toward the lockout of that user; one attempt
is harmless, and the GM, or the operator console, can unlock.)

**c. The per-IP sign-in throttle does not hit everyone at once.** The throttle blocks an IP address after 30 failed
sign-in attempts within 15 minutes. If every request appeared to come from the proxy's address, 30 failed attempts by
anyone would block sign-in for the whole company.

1. Sign in from two devices on **different networks** (phone on mobile data, computer on office Wi-Fi).
2. **Active sessions** must show two **different** IP addresses. If both show the same address, the IP is not
   being resolved (go back to step a).
3. Note: staff in one shop sharing one internet connection correctly share one IP. 30 failures per
   15 minutes is well above normal use, but a shared connection is the reason the limit is not lower.

## 5. After every deploy

- `GET /api/health` returns `200`.
- The login page shows the company name and logo from Settings, not "Jewelry ERP".
- No demo accounts are listed on the login page (they are listed only in demo mode).

## Remaining limits (known and accepted for now)

- **One instance.** The per-IP throttle and the dummy counters for unknown usernames are in memory, so a
  second instance would double the effective allowance, and settings changes reach other instances within
  5 s. Move the counters to PostgreSQL or Redis before scaling out.
- **The proxy's header format.** The app relies on `X-Forwarded-For` as the proxy writes it. If a CDN is
  added in front of Render, repeat section 4: the hop count usually changes.
