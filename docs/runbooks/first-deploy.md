# Runbook: first deployment on a fresh Linux server

Provider-neutral: hosting is the owner's decision (BACKLOG HOST-1). The steps assume an Ubuntu 24.04 LTS server with a
public IP, a final domain name (`erp.example.com` below), and root access. Every command is meant to be copied. Do the
steps in order; each one ends with a check.

> **Before you start.** Have ready: the final domain, already pointing at the server (passkeys belong to it and cannot be
> moved later), three long random passwords (owner, runtime, backup roles), and an off-site place for backups (§7.5 of
> `docs/DEPLOYMENT.md`).

> **Two shell helpers used in every runbook.** Define them in the root shell before you start (they run a command as the
> service user with the service's environment, read by the shell, so values may contain spaces when quoted):
>
> ```bash
> jerp()        { ( set -a; . /etc/jerp.env;        set +a; cd /srv/jerp/app && runuser -u jerp -- "$@" ); }
> jerp_backup() { ( set -a; . /etc/jerp-backup.env; set +a; cd /srv/jerp/app && runuser -u jerp -- "$@" ); }
> ```

## 1. Operating system user and packages

```bash
adduser --system --group --home /srv/jerp jerp            # the app runs as this user, never as root
apt-get update && apt-get install -y git curl ca-certificates age openssl ufw
# Node.js 22 LTS (20 is the minimum)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
node --version                                            # v22.x
```

## 2. PostgreSQL 16

```bash
apt-get install -y postgresql-16 postgresql-client-16
systemctl enable --now postgresql
sudo -u postgres psql -c "SHOW server_version;"           # 16.x
```

PostgreSQL listens on `localhost` only (the Ubuntu default): keep it that way. The database is never reachable from the
internet (§8).

## 3. Database, roles and grants

As the `postgres` admin user (`sudo -u postgres psql`), replace the three passwords:

```sql
CREATE DATABASE jewelry_erp;
CREATE ROLE jerp_owner  LOGIN PASSWORD '<owner password>';   -- runs the migrations, owns the tables
CREATE ROLE jerp_app    LOGIN PASSWORD '<runtime password>'; -- the app connects as this role, owns nothing
CREATE ROLE jerp_backup LOGIN PASSWORD '<backup password>' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT, CREATE ON DATABASE jewelry_erp TO jerp_owner;
GRANT CONNECT ON DATABASE jewelry_erp TO jerp_app, jerp_backup;
\c jewelry_erp
GRANT USAGE, CREATE ON SCHEMA public TO jerp_owner;
GRANT USAGE ON SCHEMA public TO jerp_app;
```

Then as the owner (`psql "postgresql://jerp_owner:<owner password>@127.0.0.1:5432/jewelry_erp"`), **before** the first
migration:

```sql
ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jerp_app;
ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO jerp_app;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO jerp_app;
```

The migrations then take UPDATE, DELETE and TRUNCATE away from the runtime role on every append-only table. The backup
role's grants are given after the first start (§9), when the `drizzle` schema exists.

## 4. The application

```bash
sudo -u jerp git clone https://github.com/<owner>/jewelry-erp.git /srv/jerp/app
cd /srv/jerp/app && sudo -u jerp git checkout <release tag>
sudo -u jerp npm ci --include=dev       # the start command runs TypeScript through tsx (a dev dependency)
sudo -u jerp npm run build
```

## 5. Environment file (mode 600)

```bash
install -o root -g root -m 600 /srv/jerp/app/.env.example /etc/jerp.env
nano /etc/jerp.env      # fill every <placeholder>; see docs/DEPLOYMENT.md §2
```

systemd reads the file as root before dropping privileges, so `root:root 600` is enough. Never copy it into the
repository.

## 6. Preflight (read-only)

```bash
jerp node scripts/server/preflight.mjs
```

Every line must say PASS (a WARN is explained in its line). Fix each FAIL with the hint printed next to it, then run the
preflight again. Before the first start the "migrations" check reports how many migrations will be applied.

## 7. systemd unit

`/etc/systemd/system/jerp.service`:

```ini
[Unit]
Description=Jewelry ERP
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=jerp
Group=jerp
WorkingDirectory=/srv/jerp/app
EnvironmentFile=/etc/jerp.env
Environment=TZ=UTC NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
# Longer than SHUTDOWN_GRACE_MS (15 s): running requests finish before the stop.
TimeoutStopSec=30
KillSignal=SIGTERM
MemoryMax=1G
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now jerp
journalctl -u jerp -n 50 --no-pager      # "server started"; no "refusing to start", no "SECURITY WARNING"
curl -fsS http://127.0.0.1:4000/api/ready   # {"ready":true}
```

## 8. Reverse proxy (TLS) and firewall

Any reverse proxy works if it: terminates TLS for the final domain; forwards to `127.0.0.1:4000`; passes the `Origin`
header **unchanged**; sets `X-Forwarded-For` and `X-Forwarded-Proto`, so the audit log sees real client IPs (D-cln3-1,
`TRUST_PROXY=1` for one proxy). Example with Caddy (automatic certificates):

```bash
apt-get install -y caddy
cat > /etc/caddy/Caddyfile <<'EOF'
erp.example.com {
  reverse_proxy 127.0.0.1:4000
}
EOF
systemctl reload caddy
```

Caddy passes `Origin` unchanged and sets the `X-Forwarded-*` headers by default. Other proxies (nginx and others) need
the same: no Origin rewriting, `proxy_set_header X-Forwarded-For`/`X-Forwarded-Proto`.

```bash
ufw default deny incoming && ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
ufw status                          # 22, 80, 443 only; 4000 and 5432 are NOT open
```

Verify the proxy with the Origin echo test (`docs/DEPLOYMENT.md` §6) and the client IP check (§4).

## 9. Backup role grants and the first backup

As the owner (the `drizzle` schema exists now):

```sql
GRANT USAGE ON SCHEMA public, drizzle TO jerp_backup;
GRANT SELECT ON ALL TABLES    IN SCHEMA public, drizzle TO jerp_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO jerp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE jerp_owner IN SCHEMA public  GRANT SELECT ON TABLES    TO jerp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE jerp_owner IN SCHEMA public  GRANT SELECT ON SEQUENCES TO jerp_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE jerp_owner IN SCHEMA drizzle GRANT SELECT ON TABLES    TO jerp_backup;
```

Then set up the key, the off-site copy and the schedule (`docs/DEPLOYMENT.md` §7.3–7.6; the backup variables go in
`/etc/jerp-backup.env`, root, mode 600, with `APP_MODE=production`), run `jerp_backup npm run backup` once and do the
first restore drill (`docs/runbooks/restore-drill.md`) **before** any real data is entered. The schedule (root's
crontab): `30 1 * * * set -a; . /etc/jerp-backup.env; set +a; cd /srv/jerp/app && runuser -u jerp -- npm run backup >> /var/log/jerp-backup.log 2>&1`.

## 10. First General Manager and passkey

```bash
jerp npm run bootstrap -w @jerp/backend -- --username <first.lastname> --full-name "<Name>" --full-name-ar "<الاسم>"
```

It prints a one-time password once. Open `https://erp.example.com`, sign in, change the password, register a passkey
on the shop PC and a second device, and print the recovery codes (`docs/DEPLOYMENT.md` §8).

## 11. Post-deploy checklist

- [ ] `curl -fsS https://erp.example.com/api/health` → `{"ok":true,…}`
- [ ] `curl -fsS https://erp.example.com/api/ready` → `{"ready":true}`
- [ ] The sign-in page shows the company name and logo from Settings; no "Demo" badge; no accounts listed.
- [ ] The start-up log has no `refusing to start`, no `SECURITY WARNING`, no `integrity constraints left NOT VALID`.
- [ ] The Origin echo test returns the origin unchanged (DEPLOYMENT §6).
- [ ] The audit log shows real client IPs, not the proxy's (DEPLOYMENT §4).
- [ ] `ufw status`: only 22, 80, 443.
- [ ] The first backup exists off-site and the first restore drill passed.
- [ ] The General Manager has two passkeys and the recovery codes are printed and stored.
- [ ] The allowed karats and the scrap buying rates are set with the client.
