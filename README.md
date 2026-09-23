# Jewelry Retail ERP — Client Demo Prototype

A working prototype of a multi-branch jewelry retail ERP: item-level inventory, point of sale,
**Hasad Gold** withdrawal redemption with weight-difference settlement, branch profitability,
executive dashboards, user & password administration, active-session monitoring and a full audit trail.

> **Prototype scope.** All data is fictional demo data. There is **no connection** to any real
> server, database, or the real Hasad Gold system. Hasad Gold is simulated by a mock service that
> implements the same interface the real integration will use.

## Quick start

Requirements: **Node.js 20+** (nothing else — the database is embedded).

```bash
npm install
npm run demo          # builds the UI and starts everything on http://localhost:4000
```

On first start the embedded PostgreSQL (PGlite) database is created in `.data/` and filled with
~30 days of realistic demo activity relative to *today*. To rebuild the demo data at any time:

```bash
npm run db:reset      # stop the server first (the embedded DB is single-process)
```

…or, while the app is running, sign in as General Manager → **Settings → Reset demo data**.

Development mode (hot reload, UI on http://localhost:5173):

```bash
npm run dev
```

Use a real PostgreSQL server instead of the embedded one:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/jewelry_erp npm run demo
```

Run the tests (end-to-end API flow on an in-memory database):

```bash
npm test
```

## Demo accounts (fictitious credentials)

| Username | Password | Role | Branch |
|---|---|---|---|
| `general.manager` | `demo-gm-2026` | General Manager | All branches |
| `branch.manager.kh` | `demo-bm-2026` | Branch Manager | Khartoum |
| `cashier.kh.01` | `demo-cashier-2026` | Cashier | Khartoum |
| `cashier.kh.02` | `demo-cashier-2026` | Cashier | Khartoum |
| `branch.manager.omd` | `demo-bm-2026` | Branch Manager | Omdurman |
| `cashier.omd.01` | `demo-cashier-2026` | Cashier | Omdurman |

Also available: `branch.manager.bhr`, `cashier.bhr.01`, `branch.manager.pzu`, `cashier.pzu.01`.
The login page lists the main accounts; click one to fill the form.

Hasad pickup codes for the demo: **HG-10025 → 482913** (Ahmed Mohamed, 4.200 g, Khartoum),
HG-10027 → 640218, HG-10026 → 193577, HG-10028 → 775104.

## What to show the client

See **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)**. It is a 12-step walkthrough covering cashier, branch manager
and general manager views, a normal sale, a Hasad withdrawal (both settlement directions),
inventory movement, profit, drill-down, active sessions and the audit trail.

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout, domain rules, configurable items, assumptions, plan |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, relationships, traceability, ledger |
| [docs/HASAD_INTEGRATION.md](docs/HASAD_INTEGRATION.md) | The `HasadService` contract and how to replace the mock |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Step-by-step client presentation |

## Repository layout

```
shared/               domain enums, permissions & default roles, settlement rule, settings defaults
database/             Drizzle schema, client factory (PostgreSQL | PGlite), SQL migrations
integrations/hasad/   HasadService interface + MockHasadService (isolated `hasad_mock` schema)
backend/              Express API: auth, authz, modules (sales, hasad, inventory, …), seed, tests
frontend/             React + Tailwind UI (POS, dashboards, reports, admin), i18n EN/AR (RTL)
docs/                 architecture & presentation material
```
