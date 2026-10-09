// npm run dev:sample [-- --json]
//
// DEVELOPMENT ONLY (REM-3, SPEC §16): fills an EMPTY demo-mode database with a small, clearly labelled sample
// (two branches, staff, types, products, a supplier order per branch, a few sales by cash, bank transfer and
// Hasad, scrap purchases and one transfer in transit) for screenshots and local trials.
//
// - Refuses APP_MODE=production and refuses any database that already has a user.
// - Every business record goes through the REAL services (ledger, numbering, audit as in real use).
// - Names come from src/dev/sample-names.json: marked placeholders until the owner supplies real, client-
//   approved names. Nothing here invents names.
// - Passwords are generated and printed once (never published); the accounts do not need a password change.
//   The second factor follows the normal rules: start the server with TWO_FACTOR_REQUIRED_ROLES_INITIAL= (empty)
//   on its first start to try the sample without a passkey.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import { t } from '@jerp/database';
import { KARATS } from '@jerp/shared';
import { config } from '../config';
import { createContext, openDatabase } from '../bootstrap';
import type { Actor, Ctx } from '../core/context';
import { hashPassword } from '../auth/password';
import { loadActor } from '../modules/sessions/service';
import { bootstrapProduction } from '../modules/bootstrap/service';
import { confirmAllowedKarats } from '../modules/setup/service';
import { createBranch } from '../modules/branches/service';
import { createUser } from '../modules/users/service';
import { createCategory, createProduct, createSupplier } from '../modules/catalog/service';
import { createPurchase } from '../modules/purchases/service';
import { createSale } from '../modules/sales/service';
import { buyScrap, setScrapRates } from '../modules/scrap/service';
import { createTransfer } from '../modules/transfers/service';

interface Names {
  company: { nameAr: string; nameEn: string; taglineAr: string; taglineEn: string };
  branches: { code: string; nameAr: string; nameEn: string; city: string }[];
  types: { nameAr: string; nameEn?: string }[];
  products: { nameAr: string; nameEn?: string; type: number }[];
  suppliers: { nameAr: string; nameEn?: string }[];
  customers: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const names = JSON.parse(readFileSync(path.join(here, 'sample-names.json'), 'utf8')) as Names;
const asJson = process.argv.includes('--json');
const say = (s: string) => (asJson ? undefined : console.log(s));
const password = () => `Sample-${randomBytes(6).toString('hex')}-Pw1`;

if (config.appMode === 'production') {
  console.error('dev:sample never runs in production (APP_MODE=production).');
  process.exit(1);
}

const handle = await openDatabase({ url: config.databaseUrl, dataDir: config.dataDir, migrationUrl: config.migrationDatabaseUrl });
try {
  const ctx = createContext(handle);
  if ((await ctx.db.select({ n: count() }).from(t.users))[0].n > 0) {
    console.error('dev:sample runs only on an EMPTY database (this one already has users). Point PGLITE_DIR or DATABASE_URL at a new database.');
    process.exitCode = 1;
  } else {
    const accounts = await buildSample(ctx);
    if (asJson) console.log(JSON.stringify(accounts));
    else {
      console.log('\nSample created (development only). Accounts (passwords shown once):');
      console.table([accounts.gm, ...accounts.branchManagers, ...accounts.cashiers]);
    }
  }
} finally {
  await handle.close();
}

async function setPassword(ctx: Ctx, username: string, pw: string) {
  await ctx.db.update(t.users).set({ passwordHash: await hashPassword(pw), mustChangePassword: false, passwordChangedAt: new Date() }).where(eq(t.users.username, username));
}
async function actor(ctx: Ctx, username: string): Promise<Actor> {
  const [u] = await ctx.db.select({ id: t.users.id }).from(t.users).where(eq(t.users.username, username));
  return (await loadActor(ctx.db, u.id, null))!;
}

async function buildSample(ctx: Ctx) {
  say('Creating the General Manager…');
  const boot = await bootstrapProduction(ctx, { username: 'sample.alpha', fullName: 'Sample Alpha', fullNameAr: '[عينة] المدير العام' });
  const gmPw = password();
  await setPassword(ctx, boot.username, gmPw);
  const gm = await actor(ctx, boot.username);

  await ctx.settings.apply(
    ctx.db,
    // The sign-in tagline too (UI-A2), marked like every sample name.
    { 'company.nameAr': names.company.nameAr, 'company.nameEn': names.company.nameEn, 'branding.loginTaglineAr': names.company.taglineAr, 'branding.loginTaglineEn': names.company.taglineEn },
    { actor: { id: gm.userId, username: gm.username }, reason: 'dev:sample' },
  );
  const allowed = (await ctx.settings.get()).inventory.allowedKarats;
  await confirmAllowedKarats(ctx, gm, allowed);
  // Rates for every allowed karat (gold sell rate only where the rate form accepts the karat).
  for (const k of allowed.filter((x) => (KARATS as readonly number[]).includes(x))) {
    await ctx.db.insert(t.goldRates).values({ karat: k, pricePerGram: Math.round((190_000 * k) / 21 / 1000) * 1000, setBy: gm.userId });
  }
  await setScrapRates(ctx, gm, Object.fromEntries(allowed.map((k) => [k, Math.round((150_000 * k) / 21 / 1000) * 1000])));

  say('Branches and staff…');
  const branches: Awaited<ReturnType<typeof createBranch>>[] = [];
  const branchManagers: { username: string; password: string; role: string }[] = [];
  const cashiers: { username: string; password: string; role: string }[] = [];
  for (const [i, b] of names.branches.entries()) {
    const row = await createBranch(ctx, gm, { code: b.code, name: b.nameEn, nameAr: b.nameAr, city: b.city });
    branches.push(row);
    const letter = String.fromCharCode(97 + i); // a, b, …
    for (const [role, list, prefix] of [['BRANCH_MANAGER', branchManagers, 'sample.bravo'], ['CASHIER', cashiers, 'sample.charlie']] as const) {
      const username = `${prefix}.${letter}`;
      await createUser(ctx, gm, { username, fullName: `${prefix.replace('sample.', 'Sample ')} ${letter.toUpperCase()}`, roleCode: role, branchId: row.id });
      const pw = password();
      await setPassword(ctx, username, pw);
      list.push({ username, password: pw, role });
    }
  }

  say('Types, products and a supplier…');
  const types: Awaited<ReturnType<typeof createCategory>>[] = [];
  for (const ty of names.types) types.push(await createCategory(ctx, gm, { nameAr: ty.nameAr, name: ty.nameEn ?? null }));
  const products: Awaited<ReturnType<typeof createProduct>>[] = [];
  for (const [i, p] of names.products.entries()) {
    products.push(await createProduct(ctx, gm, { nameAr: p.nameAr, name: p.nameEn ?? null, karat: allowed[i % allowed.length], categoryId: types[p.type].id }));
  }
  const supplier = await createSupplier(ctx, gm, { nameAr: names.suppliers[0].nameAr, name: names.suppliers[0].nameEn ?? null });

  say('Supplier orders, sales, scrap and a transfer…');
  for (const [bi, b] of branches.entries()) {
    const bm = await actor(ctx, branchManagers[bi].username);
    const lines = Array.from({ length: 8 }, (_, i) => {
      const p = products[i % products.length];
      const net = 3_000 + ((i * 1_370 + bi * 410) % 9_000);
      return { productId: p.id, grossWeightMg: net + 120, netWeightMg: net, purchaseCost: Math.round(net * 170) , makingCost: 40_000, otherCost: 0, sellingPrice: Math.round(net * 230 / 1000) * 1000 };
    });
    await createPurchase(ctx, bm, { branchId: b.id, supplierId: supplier.id, lines, makingChargePaidFrom: 'CASH' });
  }
  const a = branches[0];
  const cashier = await actor(ctx, cashiers[0].username);
  const stock = await ctx.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(eq(t.jewelryItems.branchId, a.id)).orderBy(t.jewelryItems.id);
  await createSale(ctx, cashier, { items: [{ itemId: stock[0].id }], paymentMethod: 'CASH', customerNameAr: names.customers[0] });
  await createSale(ctx, cashier, { items: [{ itemId: stock[1].id }], paymentMethod: 'BANK_TRANSFER', paymentRefTransaction: 'TRF-000142', customerNameAr: names.customers[1 % names.customers.length] });
  await createSale(ctx, cashier, { items: [{ itemId: stock[2].id }], paymentMethod: 'HASAD', paymentRefInvoice: 'SAMPLE-0001' });
  const bmA = await actor(ctx, branchManagers[0].username);
  await buyScrap(ctx, bmA, { branchId: a.id, kind: 'BROKEN', karat: allowed[0], grossWeightMg: 4_250, netWeightMg: 4_250, paymentMethod: 'CASH' });
  await buyScrap(ctx, bmA, { branchId: a.id, kind: 'SELLABLE', karat: products[0].karat, grossWeightMg: 3_640, netWeightMg: 3_640, paymentMethod: 'CASH', productId: products[0].id, sellingPrice: 900_000 });
  if (branches[1]) await createTransfer(ctx, bmA, { toBranchId: branches[1].id, itemIds: [stock[3].id], courierName: '[عينة] مندوب التوصيل' });

  return { gm: { username: boot.username, password: gmPw, role: 'GENERAL_MANAGER' }, branchManagers, cashiers };
}
