// Deterministic demo data generator.
//
// Business transactions are created through the REAL service functions (with backdated
// timestamps), so the ledger, item lifecycle, numbering and audit trail are exactly what the
// application itself would have produced. Only history that no service can backdate
// (sessions, completed Hasad redemptions) is written directly — using the same ledger helpers.

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { t } from '@jerp/database';
import { hasadMockTables } from '@jerp/hasad';
import {
  calculateSettlement,
  DEFAULT_SETTINGS,
  type PaymentMethod,
  ap,
} from '@jerp/shared';
import type { Actor, Ctx } from '../core/context';
import { writeAudit } from '../core/audit';
import { config } from '../config';
import { nextNumber } from '../core/numbering';
import { addDays, dayKey, dayStart } from '../core/time';
import { hashPassword } from '../auth/password';
import { createSession, hashToken, loadActor } from '../modules/sessions/service';
import { createPurchase, type PurchaseLine } from '../modules/purchases/service';
import { createSale, voidSale } from '../modules/sales/service';
import { createExpense } from '../modules/expenses/service';
import { post as postLedger, settleHasadReceivable, balances as ledgerBalances } from '../modules/ledger/service';
import { createTransfer, receiveTransfer } from '../modules/transfers/service';
import { adjustItem } from '../modules/inventory/service';
import { buyScrap } from '../modules/scrap/service';
import { settleWithScrap } from '../modules/supplier-settlements/service';
import { changeStatus, recordMovement } from '../modules/inventory/ledger';
import { seedRolesAndPermissions } from './reference';
import { BRANCHES, CATEGORIES, COMPANY, CUSTOMER_NAMES, DEMO_PASSWORDS, HASAD_CUSTOMERS, PRODUCTS, SUPPLIERS, USERS } from './catalog';

const { mockCustomers, mockWithdrawals } = hasadMockTables;

// ───────── deterministic randomness ─────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedDemo(ctx: Ctx, now = new Date(), opts: { twoFactor?: boolean } = {}) {
  const rand = mulberry32(20260923);
  const between = (a: number, b: number) => a + rand() * (b - a);
  const int = (a: number, b: number) => Math.floor(between(a, b + 1));
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const chance = (p: number) => rand() < p;
  const db = ctx.db;
  const tz = DEFAULT_SETTINGS.company.timezone;
  const today = dayKey(now, tz);

  /** Timestamp `offset` days from today at hh:mm (business timezone). */
  const at = (offset: number, h: number, m = 0) => new Date(dayStart(addDays(today, offset), tz).getTime() + (h * 60 + m) * 60_000);
  const todayStart = dayStart(today, tz).getTime();
  const windowStart = Math.max(todayStart + 8 * 3600_000, now.getTime() - 11 * 3600_000);
  const todayWindow: [number, number] | null =
    now.getTime() - 3 * 60_000 - windowStart > 20 * 60_000
      ? [windowStart, now.getTime() - 3 * 60_000]
      : now.getTime() - todayStart > 20 * 60_000
        ? [todayStart + 60_000, now.getTime() - 60_000]
        : null;
  /** A random time on day `offset` during trading hours (today: before now). */
  const timeOn = (offset: number, fromH = 9, toH = 21): Date | null => {
    if (offset === 0) {
      if (!todayWindow) return null;
      return new Date(between(todayWindow[0], todayWindow[1]));
    }
    return new Date(at(offset, 0).getTime() + between(fromH, toH) * 3600_000);
  };

  // ───────── gold rates (slow upward trend) ─────────
  const r21At = (offset: number) => Math.round((190_000 - (Math.max(-60, offset) / -60) * 8_500) / 500) * 500;
  const rateFor = (karat: number, offset: number) => {
    const r21 = r21At(offset);
    const factor = karat === 24 ? 1.142 : karat === 22 ? 1.047 : karat === 18 ? 0.857 : karat / 21;
    return Math.round((r21 * factor) / 500) * 500;
  };

  // ───────── settings, permissions, roles ─────────
  const roleId = await seedRolesAndPermissions(db);
  ctx.settings.invalidate();
  await ctx.settings.apply(
    db,
    {
      'company.nameEn': COMPANY.name,
      'company.nameAr': COMPANY.nameAr,
      'branding.invoiceFooterEn': COMPANY.invoiceFooter,
      'branding.invoiceFooterAr': COMPANY.invoiceFooterAr,
      'hasad.enabledPerBranch': Object.fromEntries(BRANCHES.map((b) => [b.code, true])),
      // This client sells 21K only (D-4-1). Broken scrap of any karat is still bought.
      'inventory.allowedKarats': [21],
      // Demo: no second factor by default, so the login page and the demo script keep working
      // (D-2fa-10). DEMO_TWO_FACTOR=true keeps it required for the General Manager (testing).
      'security.twoFactorRequiredRoles': (opts.twoFactor ?? config.demoTwoFactor) ? ['GENERAL_MANAGER'] : [],
    },
    { actor: { id: null, username: 'demo-seed' }, allowDemoOnly: true, allowGuarded: true },
  );

  // ───────── branches & users ─────────
  const branchRows = await db.insert(t.branches).values([...BRANCHES].map((b) => ({ ...b, createdAt: at(-400, 9) }))).returning();
  const branch = Object.fromEntries(branchRows.map((b) => [b.code, b]));
  const passwordHash: Record<string, string> = {};
  for (const [role, pw] of Object.entries(DEMO_PASSWORDS)) passwordHash[role] = await hashPassword(pw);
  const userRows = await db
    .insert(t.users)
    .values(
      USERS.map((u) => ({
        username: u.username,
        fullName: u.fullName,
        fullNameAr: u.fullNameAr,
        phone: u.phone,
        roleId: roleId[u.role],
        branchId: u.branch ? branch[u.branch].id : null,
        passwordHash: passwordHash[u.role],
        passwordChangedAt: at(-90, 10),
        createdAt: at(-120, 10),
      })),
    )
    .returning();
  const actors: Record<string, Actor> = {};
  for (const u of userRows) actors[u.username] = (await loadActor(db, u.id, null))!;
  const gm = actors['general.manager'];
  const bm: Record<string, Actor> = {
    KRT: actors['branch.manager.kh'],
    OMD: actors['branch.manager.omd'],
    BHR: actors['branch.manager.bhr'],
    PZU: actors['branch.manager.pzu'],
  };
  const cashiers: Record<string, Actor[]> = {
    KRT: [actors['cashier.kh.01'], actors['cashier.kh.02']],
    OMD: [actors['cashier.omd.01']],
    BHR: [actors['cashier.bhr.01']],
    PZU: [actors['cashier.pzu.01']],
  };

  // ───────── gold rate history ─────────
  for (const off of [-60, -45, -30, -21, -14, -7, -3, 0]) {
    const when = off === 0 ? new Date(Math.min(at(0, 8).getTime(), now.getTime() - 60_000)) : at(off, 8);
    // Selling rates only for the karat this client sells; scrap BUYING rates cover every karat (below).
    await db.insert(t.goldRates).values([21].map((k) => ({ karat: k, pricePerGram: rateFor(k, off), effectiveAt: when, setBy: gm.userId })));
  }

  // ───────── catalogue ─────────
  const catRows = await db.insert(t.categories).values(CATEGORIES.map(({ code, name, nameAr }) => ({ code, name, nameAr }))).returning();
  const catId = Object.fromEntries(catRows.map((c) => [c.code, c.id]));
  const productRows = await db
    .insert(t.products)
    .values(PRODUCTS.map((p) => ({ sku: p.sku, name: p.name, nameAr: p.nameAr, categoryId: catId[p.category], karat: p.karat, createdAt: at(-200, 9) })))
    .returning();
  const productBySku = Object.fromEntries(productRows.map((p) => [p.sku, p]));
  const productCategory = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p.category]));
  const supplierRows = await db.insert(t.suppliers).values(SUPPLIERS).returning();

  /** Realistic purchase line for a product bought `offset` days ago. */
  const makeLine = (sku: string, offset: number): PurchaseLine => {
    const p = productBySku[sku];
    const cat = CATEGORIES.find((c) => c.code === productCategory[sku])!;
    const netMg = Math.round(between(cat.weight[0], cat.weight[1]) * 100) * 10;
    const grossMg = Math.round((netMg * between(1.02, 1.08)) / 10) * 10;
    const g = netMg / 1000;
    const purchaseCost = Math.round((g * rateFor(p.karat, offset) * between(0.965, 1.0)) / 1000) * 1000;
    const makingCost = Math.round((g * between(6_000, 12_000)) / 1000) * 1000;
    const otherCost = cat.code === 'SET' ? int(2, 9) * 10_000 : 0;
    const total = purchaseCost + makingCost + otherCost;
    const sellingPrice = Math.round((total * between(1.16, 1.28)) / 5_000) * 5_000;
    return { productId: p.id, grossWeightMg: grossMg, netWeightMg: netMg, purchaseCost, makingCost, otherCost, sellingPrice };
  };
  const skus = PRODUCTS.map((p) => p.sku);
  const weightedSku = () => {
    // Rings, earrings, chains and bracelets move fastest; sets are rare.
    const r = rand();
    const cat = r < 0.27 ? 'RING' : r < 0.45 ? 'BRACELET' : r < 0.58 ? 'EARRING' : r < 0.72 ? 'CHAIN' : r < 0.85 ? 'NECKLACE' : r < 0.96 ? 'PENDANT' : 'SET';
    return pick(skus.filter((s) => productCategory[s] === cat));
  };

  // ───────── opening stock (≈ 2 months ago) ─────────
  const openingSize: Record<string, number> = { KRT: 105, OMD: 75, BHR: 60, PZU: 54 };
  const specialCodes = new Set<string>();
  for (const code of ['KRT', 'OMD', 'BHR', 'PZU']) {
    const batches = 3;
    for (let b = 0; b < batches; b++) {
      const offset = -58 + b * 5 + int(0, 2);
      const lines: PurchaseLine[] = [];
      if (code === 'KRT' && b === 0) {
        // Items from the specification, kept available for the live demo.
        const ring = productBySku['RG-21-001'].id;
        lines.push({ productId: ring, grossWeightMg: 4500, netWeightMg: 4200, purchaseCost: 800_000, makingCost: 50_000, otherCost: 0, sellingPrice: 1_050_000 });
        lines.push({ productId: ring, grossWeightMg: 4420, netWeightMg: 4180, purchaseCost: 792_000, makingCost: 50_000, otherCost: 0, sellingPrice: 1_045_000 });
        lines.push({ productId: ring, grossWeightMg: 4610, netWeightMg: 4350, purchaseCost: 826_000, makingCost: 52_000, otherCost: 0, sellingPrice: 1_090_000 });
      }
      while (lines.length < Math.round(openingSize[code] / batches)) lines.push(makeLine(weightedSku(), offset));
      // Opening stock: its making charge was paid before the system was used, so it is part of the
      // piece's cost and no money leaves the drawer now (the gold owed to the supplier remains).
      const openingLines = lines.map((l) => ({ ...l, purchaseCost: l.purchaseCost + l.makingCost, makingCost: 0 }));
      const res = await createPurchase(ctx, bm[code], { branchId: branch[code].id, supplierId: pick(supplierRows).id, supplierInvoiceNo: `SUP-${int(10000, 99999)}`, lines: openingLines, notes: 'رصيد افتتاحي' }, { at: at(offset, 10, int(0, 50)) });
      if (code === 'KRT' && b === 0) res.itemCodes.slice(0, 3).forEach((c) => specialCodes.add(c));
    }
  }

  // ───────── helpers for the daily simulation ─────────
  const protectedIds = async () =>
    specialCodes.size
      ? (await db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(inArray(t.jewelryItems.code, [...specialCodes]))).map((r) => r.id)
      : [];
  const protectedList = await protectedIds();
  const available = async (code: string) =>
    db
      .select({ id: t.jewelryItems.id, netWeightMg: t.jewelryItems.netWeightMg, karat: t.jewelryItems.karat, sellingPrice: t.jewelryItems.sellingPrice, code: t.jewelryItems.code })
      .from(t.jewelryItems)
      .where(and(eq(t.jewelryItems.branchId, branch[code].id), eq(t.jewelryItems.status, 'AVAILABLE'), notInArray(t.jewelryItems.id, protectedList.length ? protectedList : [-1])));

  // The counter takes cash, bank transfer and Hasad (D-4-6).
  const payment = (): PaymentMethod => {
    const r = rand();
    return r < 0.58 ? 'CASH' : r < 0.9 ? 'BANK_TRANSFER' : 'HASAD';
  };
  const purchaseLog: { code: string; offset: number; id: number }[] = [];
  const salesPerDay: Record<string, [number, number]> = { KRT: [1, 3], OMD: [0, 2], BHR: [0, 2], PZU: [0, 2] };
  const purchaseDays: Record<string, number[]> = { KRT: [-25, -14, -4, 0], OMD: [-22, -9], BHR: [-18, -6], PZU: [-16, -5] };
  const saleIdsByBranch: Record<string, { id: number; offset: number }[]> = { KRT: [], OMD: [], BHR: [], PZU: [] };

  // Transfers created on a given day (from, to, count, receive offset or null = in transit).
  const transferPlan = [
    { day: -20, from: 'OMD', to: 'KRT', count: 3, receive: -19 },
    { day: -12, from: 'KRT', to: 'PZU', count: 2, receive: -11 },
    { day: -1, from: 'BHR', to: 'KRT', count: 2, receive: null as number | null },
  ];
  const pendingReceipts: { day: number; id: number; to: string }[] = [];

  // ───────── 30 days of trading ─────────
  for (let offset = -30; offset <= 0; offset++) {
    const weekday = new Date(at(offset, 12)).getUTCDay(); // 5 = Friday (weekly closing day)
    for (const code of ['KRT', 'OMD', 'BHR', 'PZU']) {
      if (purchaseDays[code].includes(offset)) {
        const when = offset === 0 ? timeOn(0) : at(offset, 10, int(0, 40));
        if (when) {
          const lines = Array.from({ length: int(6, 10) }, () => makeLine(weightedSku(), offset));
          const po = await createPurchase(
            ctx,
            bm[code],
            { branchId: branch[code].id, supplierId: pick(supplierRows).id, supplierInvoiceNo: `SUP-${int(10000, 99999)}`, lines, makingChargePaidFrom: chance(0.7) ? 'CASH' : 'BANK' },
            { at: when },
          );
          purchaseLog.push({ code, offset, id: po.id });
        }
      }
      for (const tr of transferPlan.filter((x) => x.day === offset && x.from === code)) {
        const pool = await available(code);
        const itemIds = pool.slice(0, tr.count).map((i) => i.id);
        const created = await createTransfer(ctx, bm[code], { fromBranchId: branch[code].id, toBranchId: branch[tr.to].id, itemIds, notes: `موازنة المخزون: ${branch[code].nameAr} ← ${branch[tr.to].nameAr}` }, { at: at(offset, 11, 15) });
        if (tr.receive != null) pendingReceipts.push({ day: tr.receive, id: created.id, to: tr.to });
      }
      for (const pr of pendingReceipts.filter((p) => p.day === offset && p.to === code)) {
        await receiveTransfer(ctx, bm[code], pr.id, { at: at(offset, 10, 5) });
      }

      if (weekday === 5 && code !== 'KRT') continue; // most branches close on Fridays
      const [lo, hi] = salesPerDay[code];
      const n = offset === 0 ? Math.max(lo, 2) : int(lo, hi);
      for (let s = 0; s < n; s++) {
        const when = timeOn(offset);
        if (!when) break;
        const pool = await available(code);
        if (pool.length < 40) break; // keep a healthy display for the demo
        const count = chance(0.18) ? 2 : 1;
        const chosen = Array.from({ length: count }, () => pool.splice(Math.floor(rand() * pool.length), 1)[0]);
        const seller = chance(0.12) ? bm[code] : pick(cashiers[code]);
        const maxPct = DEFAULT_SETTINGS.sales.maxDiscountPercentByRole[seller.roleCode] ?? 0;
        const sale = await createSale(
          ctx,
          seller,
          {
            branchId: branch[code].id,
            items: chosen.map((i) => ({
              itemId: i.id,
              discount: chance(0.25) ? Math.floor((i.sellingPrice * between(0.4, maxPct)) / 100 / 1000) * 1000 : 0,
            })),
            ...(() => {
              const method = payment();
              return method === 'HASAD'
                ? { paymentMethod: method, paymentRefInvoice: `HSD-INV-${int(100000, 999999)}`, ...(chance(0.7) ? { paymentRefTransaction: `HTX${int(10000000, 99999999)}` } : {}) }
                : { paymentMethod: method };
            })(),
            ...(chance(0.7) ? (({ en, ar }) => ({ customerName: en, customerNameAr: ar }))(pick(CUSTOMER_NAMES)) : {}),
            customerPhone: chance(0.5) ? `+249 9${int(10, 99)} ${int(100, 999)} ${int(100, 999)}` : undefined,
          },
          { at: when },
        );
        saleIdsByBranch[code].push({ id: sale.id, offset });
      }
    }

    // Occasional stock adjustments.
    if (offset === -15) {
      const [i] = await available('BHR');
      await adjustItem(ctx, bm.BHR, i.id, 'RETURN_TO_SUPPLIER', 'عيب تصنيع: الدمغة غير واضحة', { at: at(offset, 13) });
    }
    if (offset === -8) {
      const [i] = await available('OMD');
      await adjustItem(ctx, bm.OMD, i.id, 'MARK_DAMAGED', 'القفل مكسور أثناء العرض', { at: at(offset, 16) });
    }
    if (offset === -6) {
      const pool = await available('KRT');
      const i = pool[pool.length - 1];
      await adjustItem(ctx, bm.KRT, i.id, 'MARK_DAMAGED', 'خدوش على السطح: أُرسلت للورشة', { at: at(offset, 12) });
      await adjustItem(ctx, bm.KRT, i.id, 'RESTOCK', 'تم تلميعها في الورشة وأُعيدت للعرض', { at: at(offset + 3, 11) });
    }
  }

  // Two cancelled sales (manager-approved voids).
  const voidPlan: [string, number, string][] = [
    ['KRT', -5, 'أرجع العميل القطعة في اليوم نفسه: المقاس غير مناسب'],
    ['OMD', -12, 'تم مسح قطعة خاطئة عند الدفع'],
  ];
  for (const [code, offset, reason] of voidPlan) {
    const s = saleIdsByBranch[code].find((x) => x.offset === offset) ?? saleIdsByBranch[code].find((x) => x.offset > offset);
    if (s) await voidSale(ctx, bm[code], s.id, reason, { at: at(s.offset, 20, 30) });
  }

  // ───────── expenses ─────────
  const monthStart = today.slice(0, 8) + '01';
  const prevMonthStart = addDays(monthStart, -1).slice(0, 8) + '01';
  const offsetOf = (key: string) => Math.round((dayStart(key, tz).getTime() - todayStart) / 86400_000);
  const rent: Record<string, number> = { KRT: 3_500_000, OMD: 2_400_000, BHR: 2_000_000, PZU: 2_800_000 };
  const salaries: Record<string, number> = { KRT: 4_200_000, OMD: 3_100_000, BHR: 2_600_000, PZU: 2_900_000 };
  const addExpense = async (actor: Actor, code: string, key: string, category: string, amount: number, description: string) => {
    const off = offsetOf(key);
    if (off > 0 || off < -45) return;
    const when = off === 0 ? (timeOn(0) ?? new Date(now.getTime() - 60_000)) : at(off, 12, int(0, 59));
    await createExpense(ctx, actor, { branchId: branch[code].id, category: category as never, amount, expenseDate: key, description }, { at: when });
  };
  for (const code of ['KRT', 'OMD', 'BHR', 'PZU']) {
    for (const ms of [prevMonthStart, monthStart]) {
      await addExpense(gm, code, ms, 'RENT', rent[code], `إيجار المحل: ${ms.slice(0, 7)}`);
      await addExpense(bm[code], code, ms.slice(0, 8) + '10', 'ELECTRICITY', int(28, 45) * 10_000, 'فاتورة الكهرباء (رصيد مسبق الدفع)');
      await addExpense(bm[code], code, ms.slice(0, 8) + '15', 'SECURITY', 350_000, 'خدمة الحراسة الليلية');
    }
    await addExpense(gm, code, prevMonthStart.slice(0, 8) + '25', 'SALARIES', salaries[code], 'مرتبات الموظفين');
    for (let off = -40; off <= -1; off += int(4, 7)) {
      await addExpense(bm[code], code, addDays(today, off), 'TRANSPORTATION', int(4, 12) * 10_000, pick(['وقود عربة التوصيل', 'مندوب إلى الرئاسة', 'ركشة: إيداعات البنك', 'ترحيل بضاعة إلى الورشة']));
    }
    await addExpense(bm[code], code, addDays(today, -int(3, 20)), 'MAINTENANCE', int(15, 60) * 10_000, pick(['صيانة إضاءة فترينة العرض', 'صيانة قفل الخزنة', 'معايرة الميزان', 'صيانة المولد']));
  }
  await addExpense(bm.KRT, 'KRT', today, 'OTHER', 35_000, 'شاي ومياه للموظفين');
  await addExpense(bm.KRT, 'KRT', today, 'TRANSPORTATION', 60_000, 'مندوب إلى فرع أم درمان');
  await addExpense(bm.OMD, 'OMD', today, 'OTHER', 20_000, 'مستلزمات نظافة');
  await addExpense(bm.BHR, 'BHR', addDays(today, -1), 'MAINTENANCE', 2_350_000, 'استبدال مكيف منطقة العرض'); // above threshold → PENDING

  // ───────── scrap gold and supplier settlements (Phase 4) ─────────
  // Scrap BUYING rates (any karat, set by the GM) a little under the selling rate; broken scrap
  // bought at the counter goes to the branch pool; supplier representatives are paid in that scrap.
  const scrapRate = (karat: number, offset: number) => Math.round((rateFor(karat, offset) * 0.93) / 500) * 500;
  const scrapRateDays = [-31, -14, -3];
  let nextRate = 0;
  const ratesUpTo = async (offset: number) => {
    while (nextRate < scrapRateDays.length && scrapRateDays[nextRate] <= offset) {
      const off = scrapRateDays[nextRate++];
      await db.insert(t.scrapRates).values([14, 18, 21, 22, 24].map((k) => ({ karat: k, pricePerGram: scrapRate(k, off), effectiveAt: at(off, 8, 5), setBy: gm.userId })));
    }
  };
  type ScrapEvent =
    | { day: number; code: string; kind: 'BROKEN'; karat: number; g: number; pay: 'CASH' | 'BANK_TRANSFER' }
    | { day: number; code: string; kind: 'SELLABLE'; sku: string; g: number; pay: 'CASH' | 'BANK_TRANSFER' }
    | { day: number; code: string; kind: 'SETTLE'; purchase: number; karat: number; g: number | 'REST' };
  const krtPO = purchaseLog.find((p) => p.code === 'KRT' && p.offset === -25)!;
  const omdPO = purchaseLog.find((p) => p.code === 'OMD' && p.offset === -22)!;
  const bhrPO = purchaseLog.find((p) => p.code === 'BHR' && p.offset === -18)!;
  const scrapPlan: ScrapEvent[] = [
    { day: -27, code: 'KRT', kind: 'BROKEN', karat: 21, g: 38.6, pay: 'CASH' },
    { day: -24, code: 'OMD', kind: 'BROKEN', karat: 21, g: 22.4, pay: 'CASH' },
    { day: -21, code: 'KRT', kind: 'BROKEN', karat: 18, g: 14.2, pay: 'CASH' },
    { day: -19, code: 'BHR', kind: 'BROKEN', karat: 21, g: 17.9, pay: 'CASH' },
    { day: -17, code: 'KRT', kind: 'SELLABLE', sku: 'BR-21-001', g: 12.35, pay: 'CASH' },
    { day: -16, code: 'PZU', kind: 'BROKEN', karat: 22, g: 9.8, pay: 'CASH' },
    { day: -15, code: 'KRT', kind: 'BROKEN', karat: 21, g: 41.3, pay: 'BANK_TRANSFER' },
    { day: -13, code: 'KRT', kind: 'SETTLE', purchase: krtPO.id, karat: 21, g: 45 },
    { day: -12, code: 'OMD', kind: 'BROKEN', karat: 24, g: 6.5, pay: 'CASH' },
    { day: -11, code: 'OMD', kind: 'SELLABLE', sku: 'RG-21-001', g: 4.6, pay: 'CASH' },
    { day: -10, code: 'OMD', kind: 'SETTLE', purchase: omdPO.id, karat: 21, g: 20 },
    { day: -9, code: 'KRT', kind: 'BROKEN', karat: 21, g: 28.7, pay: 'CASH' },
    { day: -8, code: 'BHR', kind: 'BROKEN', karat: 18, g: 11.1, pay: 'CASH' },
    { day: -7, code: 'KRT', kind: 'SETTLE', purchase: krtPO.id, karat: 18, g: 14.2 },
    { day: -6, code: 'BHR', kind: 'SETTLE', purchase: bhrPO.id, karat: 21, g: 15 },
    { day: -4, code: 'PZU', kind: 'BROKEN', karat: 21, g: 19.4, pay: 'CASH' },
    { day: -3, code: 'KRT', kind: 'BROKEN', karat: 21, g: 64.2, pay: 'BANK_TRANSFER' },
    { day: -2, code: 'KRT', kind: 'SETTLE', purchase: krtPO.id, karat: 21, g: 'REST' },
    { day: -1, code: 'KRT', kind: 'BROKEN', karat: 22, g: 7.3, pay: 'CASH' },
    { day: -1, code: 'BHR', kind: 'BROKEN', karat: 14, g: 6.2, pay: 'CASH' }, // odd karat: scrap buying accepts 1–24
    { day: -1, code: 'OMD', kind: 'BROKEN', karat: 21, g: 13.6, pay: 'CASH' },
  ];
  for (const ev of scrapPlan) {
    await ratesUpTo(ev.day);
    const when = at(ev.day, 15, int(0, 50));
    const customer = pick(CUSTOMER_NAMES);
    if (ev.kind === 'SETTLE') {
      let weightMg: number;
      if (ev.g === 'REST') {
        // The last visit settles the order in full: the weight whose 24K equivalent is exactly what is owed.
        const [po] = await db.select({ owed: t.purchases.goldOwedMgPure24 }).from(t.purchases).where(eq(t.purchases.id, ev.purchase));
        weightMg = Math.round((po.owed! * 24) / ev.karat);
      } else weightMg = Math.round(ev.g * 1000);
      await settleWithScrap(ctx, bm[ev.code], ev.purchase, { karat: ev.karat, weightMg, note: 'زيارة مندوب المورد' }, { at: when });
      continue;
    }
    const mg = Math.round(ev.g * 100) * 10;
    if (ev.kind === 'BROKEN') {
      await buyScrap(ctx, bm[ev.code], { branchId: branch[ev.code].id, kind: 'BROKEN', karat: ev.karat, grossWeightMg: mg, netWeightMg: mg, paymentMethod: ev.pay, customerName: customer.ar, note: 'كسر ذهب من عميل' }, { at: when });
    } else {
      const p = productBySku[ev.sku];
      const sellingPrice = Math.round((mg / 1000) * rateFor(21, ev.day) * 1.12 / 5_000) * 5_000;
      await buyScrap(
        ctx,
        bm[ev.code],
        { branchId: branch[ev.code].id, kind: 'SELLABLE', karat: 21, grossWeightMg: mg, netWeightMg: mg, paymentMethod: ev.pay, productId: p.id, sellingPrice, customerName: customer.ar, note: 'قطعة سليمة صالحة للبيع' },
        { at: when },
      );
    }
  }
  await ratesUpTo(0);

  // Hasad paid most branches part of what it owes them, by bank transfer (receivable → bank).
  for (const code of ['KRT', 'OMD']) {
    const due = (await ledgerBalances(db, branch[code].id)).find((a) => a.kind === 'HASAD_RECEIVABLE')?.balance ?? 0;
    const amount = Math.floor((due * 0.6) / 1000) * 1000;
    if (amount > 0) {
      await settleHasadReceivable(ctx, bm[code], { branchId: branch[code].id, amount, bankReference: `BOK-${int(1000000, 9999999)}`, note: 'دفعة من حصاد' }, { at: at(-1, 11, 30) });
    }
  }

  // ───────── Hasad Gold (mock system + ERP history) ─────────
  await db.insert(mockCustomers).values(
    HASAD_CUSTOMERS.map((c, i) => ({
      id: c.id,
      fullName: c.fullName,
      fullNameAr: c.fullNameAr,
      phone: c.phone,
      nationalIdMasked: c.nid,
      balanceMg: [4200, 7850, 3100, 10500, 5000, 2600, 6400][i] ?? int(2, 14) * 100 + int(0, 9) * 10,
      karat: 21,
      createdAt: at(-300 + i * 7, 12),
    })),
  );

  let wSeq = 10012;
  const nextW = () => `HG-${wSeq++}`;
  const pickup = () => String(int(100000, 999999));

  const historical: { day: number; code: string; cust: number; mg: number }[] = [
    { day: -27, code: 'KRT', cust: 7, mg: 5000 },
    { day: -24, code: 'OMD', cust: 8, mg: 3500 },
    { day: -21, code: 'KRT', cust: 9, mg: 8200 },
    { day: -17, code: 'BHR', cust: 10, mg: 4000 },
    { day: -14, code: 'PZU', cust: 11, mg: 6300 },
    { day: -11, code: 'KRT', cust: 12, mg: 2800 },
    { day: -8, code: 'OMD', cust: 13, mg: 12000 },
    { day: -5, code: 'KRT', cust: 14, mg: 4600 },
    { day: -3, code: 'BHR', cust: 15, mg: 3300 },
    { day: -1, code: 'KRT', cust: 16, mg: 5500 },
  ];
  const cancelled = [
    { day: -19, code: 'KRT', cust: 17, mg: 3000, reason: 'طلب العميل الإلغاء عبر الهاتف', by: 'KRT' },
    { day: -9, code: 'PZU', cust: 13, mg: 2000, reason: 'لم يستلم العميل خلال 14 يوماً', by: 'PZU' },
    { day: -4, code: 'OMD', cust: 17, mg: 2500, reason: 'ألغاه العميل من تطبيق حصاد', by: null },
  ];

  const events = [
    ...historical.map((h) => ({ ...h, kind: 'done' as const })),
    ...cancelled.map((c) => ({ ...c, kind: 'cancel' as const })),
  ].sort((a, b) => a.day - b.day);

  for (const ev of events) {
    const c = HASAD_CUSTOMERS[ev.cust];
    const b = branch[ev.code];
    const id = nextW();
    const requestedAt = at(ev.day - int(1, 3), int(8, 20), int(0, 59));
    const receivedAt = new Date(requestedAt.getTime() + 60_000);
    if (ev.kind === 'cancel') {
      const cancelledAt = at(ev.day, 14, 10);
      await db.insert(mockWithdrawals).values({
        id, customerId: c.id, weightMg: ev.mg, karat: 21, branchCode: b.hasadBranchCode!, status: 'CANCELLED', pickupCode: pickup(), requestedAt, updatedAt: cancelledAt,
        cancellation: { reason: ev.reason, cancelledAt: cancelledAt.toISOString(), source: ev.by ? 'ERP' : 'HASAD' },
      });
      const [w] = await db.insert(t.hasadWithdrawals).values({
        externalId: id, hasadCustomerId: c.id, customerName: c.fullName, customerNameAr: c.fullNameAr, customerPhone: c.phone, customerNationalIdMasked: c.nid,
        entitledWeightMg: ev.mg, entitlementKarat: 21, branchId: b.id, status: 'CANCELLED', externalStatus: 'CANCELLED', requestedAt, receivedAt,
        cancelledAt, cancelledBy: ev.by ? bm[ev.by].userId : null, cancelReason: ev.reason, lastSyncedAt: cancelledAt,
      }).returning();
      await writeAudit(db, null, { action: 'HASAD_WITHDRAWAL_RECEIVED', entityType: 'hasad_withdrawal', entityId: id, branchId: b.id, at: receivedAt, key: 'Withdrawal {id} received from Hasad Gold: {customer}, {weight} entitlement. No inventory reserved.', params: { id, customer: ap.text(c.fullName, c.fullNameAr), weight: ap.mg(ev.mg) } });
      await writeAudit(db, ev.by ? bm[ev.by] : null, { action: 'HASAD_WITHDRAWAL_CANCELLED', entityType: 'hasad_withdrawal', entityId: w.externalId, branchId: b.id, at: cancelledAt, key: 'Withdrawal {id} ({customer}, {weight}) cancelled: {reason}', params: { id, customer: ap.text(c.fullName, c.fullNameAr), weight: ap.mg(ev.mg), reason: ev.reason } });
      continue;
    }

    // Completed redemption: the customer picked the piece closest to their entitlement.
    const cashier = pick(cashiers[ev.code]);
    const completedAt = at(ev.day, int(10, 19), int(0, 59));
    const openedAt = new Date(completedAt.getTime() - 12 * 60_000);
    const reservedAt = new Date(completedAt.getTime() - 7 * 60_000);
    const pool = (await available(ev.code)).filter((i) => i.karat === 21);
    pool.sort((x, y) => Math.abs(x.netWeightMg - ev.mg) - Math.abs(y.netWeightMg - ev.mg));
    const choice = pool[int(0, 2)];
    const [item] = await db.select().from(t.jewelryItems).where(eq(t.jewelryItems.id, choice.id));
    const s = calculateSettlement({ entitledWeightMg: ev.mg, entitlementKarat: 21, items: [item], ratePerGram: rateFor(item.karat, ev.day), basis: 'NET_WEIGHT' });

    const [w] = await db.insert(t.hasadWithdrawals).values({
      externalId: id, hasadCustomerId: c.id, customerName: c.fullName, customerNameAr: c.fullNameAr, customerPhone: c.phone, customerNationalIdMasked: c.nid,
      entitledWeightMg: ev.mg, entitlementKarat: 21, branchId: b.id, status: 'COMPLETED', externalStatus: 'COMPLETED', pickupCode: pickup(), requestedAt, receivedAt,
      openedAt, openedBy: cashier.userId, completedAt, completedBy: cashier.userId, lastSyncedAt: completedAt,
    }).returning();
    const number = await nextNumber(db, b.code, 'HR');
    const [r] = await db.insert(t.hasadRedemptions).values({
      number, withdrawalId: w.id, branchId: b.id, cashierId: cashier.userId, status: 'COMPLETED', entitledWeightMg: ev.mg,
      deliveredWeightMg: s.deliveredWeightMg, differenceMg: s.differenceMg, settlementDirection: s.direction, settlementAmount: s.amount,
      ratePerGram: s.ratePerGram, itemsCost: item.totalCost, customerVerified: true, createdAt: openedAt, completedAt,
    }).returning();
    await db.insert(t.hasadRedemptionItems).values({ redemptionId: r.id, itemId: item.id, netWeightMg: item.netWeightMg, karat: item.karat, unitCost: item.acquisitionCost, addedAt: reservedAt });
    const ref = { refType: 'hasad_redemption', refId: r.id, refNumber: number };
    const reserved = await changeStatus(db, { item, to: 'RESERVED', from: ['AVAILABLE'], userId: cashier.userId, ref, at: reservedAt, note: `Selected by Hasad customer (${id})`, reservation: { ref: `HASAD:${number}`, userId: cashier.userId } });
    await changeStatus(db, { item: reserved, to: 'REDEEMED', from: ['RESERVED'], userId: cashier.userId, ref, at: completedAt, note: `Delivered to Hasad customer (${id})` });
    await recordMovement(db, { item, type: 'HASAD_REDEMPTION', branchId: b.id, ref, userId: cashier.userId, at: completedAt });
    let settlementNumber: string | null = null;
    if (s.direction !== 'NONE') {
      settlementNumber = await nextNumber(db, b.code, 'SET');
      await db.insert(t.settlements).values({ number: settlementNumber, type: 'HASAD_WEIGHT_DIFFERENCE', redemptionId: r.id, branchId: b.id, direction: s.direction, weightMg: s.absDifferenceMg, ratePerGram: s.ratePerGram, amount: s.amount, paymentMethod: 'CASH', confirmedBy: cashier.userId, confirmedAt: completedAt });
      // Demo history goes through the same ledger as live settlements (CASH, Q8).
      await postLedger(db, [{ branchId: b.id, kind: 'CASH', amount: s.direction === 'BRANCH_PAYS_CUSTOMER' ? -s.amount : s.amount, eventType: 'HASAD_SETTLEMENT', paymentMethod: 'CASH', ref: { refType: 'hasad_redemption', refId: r.id, refNumber: settlementNumber }, at: completedAt }], { actor: cashier });
    }
    await db.insert(mockWithdrawals).values({
      id, customerId: c.id, weightMg: ev.mg, karat: 21, branchCode: b.hasadBranchCode!, status: 'COMPLETED', pickupCode: w.pickupCode, requestedAt, updatedAt: completedAt,
      completion: {
        erpReference: number, branchCode: b.hasadBranchCode, deliveredWeightGrams: (s.deliveredWeightMg / 1000).toFixed(3),
        items: [{ code: item.code, description: item.code, karat: item.karat, netWeightGrams: (item.netWeightMg / 1000).toFixed(3) }],
        settlement: { direction: s.direction, weightGrams: (s.absDifferenceMg / 1000).toFixed(3), amount: s.amount, currency: 'SDG' },
        completedBy: cashier.username, completedAt: completedAt.toISOString(),
      },
    });
    await writeAudit(db, null, { action: 'HASAD_WITHDRAWAL_RECEIVED', entityType: 'hasad_withdrawal', entityId: id, branchId: b.id, at: receivedAt, key: 'Withdrawal {id} received from Hasad Gold: {customer}, {weight} entitlement. No inventory reserved.', params: { id, customer: ap.text(c.fullName, c.fullNameAr), weight: ap.mg(ev.mg) } });
    await writeAudit(db, cashier, { action: 'HASAD_WITHDRAWAL_OPENED', entityType: 'hasad_withdrawal', entityId: id, branchId: b.id, at: openedAt, key: 'Customer {customer} at counter for {id} ({weight}). Verified by pickup code.', params: { customer: ap.text(c.fullName, c.fullNameAr), id, weight: ap.mg(ev.mg) }, metadata: { redemption: number } });
    await writeAudit(db, cashier, { action: 'ITEM_RESERVED', entityType: 'item', entityId: item.code, branchId: b.id, at: reservedAt, key: '{code} ({weight}, {karat}) reserved for Hasad withdrawal {id}', params: { code: item.code, weight: ap.mg(item.netWeightMg), karat: ap.karat(item.karat), id }, metadata: { withdrawal: id, redemption: number } });
    if (settlementNumber) {
      await writeAudit(db, cashier, { action: 'HASAD_SETTLEMENT_CONFIRMED', entityType: 'settlement', entityId: settlementNumber, branchId: b.id, at: completedAt, key: s.direction === 'BRANCH_PAYS_CUSTOMER' ? 'Branch paid customer {amount} for {weight} difference @ {rate}/g ({payment})' : 'Customer paid branch {amount} for {weight} difference @ {rate}/g ({payment})', params: { amount: ap.money(s.amount), weight: ap.mg(s.absDifferenceMg), rate: ap.money(s.ratePerGram), payment: ap.enum('CASH') }, metadata: { withdrawal: id } });
    }
    await writeAudit(db, cashier, { action: 'HASAD_WITHDRAWAL_COMPLETED', entityType: 'hasad_withdrawal', entityId: id, branchId: b.id, at: completedAt, key: '{id} completed: entitled {entitled}, delivered {delivered} ({codes})', params: { id, entitled: ap.mg(ev.mg), delivered: ap.mg(s.deliveredWeightMg), codes: item.code }, metadata: { redemption: number, settlement: settlementNumber } });
    await db.update(mockCustomers).set({ balanceMg: int(1, 9) * 100 }).where(eq(mockCustomers.id, c.id));
  }

  // Customers without an open request keep a withdrawable balance for the simulator (and one below minimum).
  await db.update(mockCustomers).set({ balanceMg: 8400 }).where(eq(mockCustomers.id, 'HC-204910'));
  await db.update(mockCustomers).set({ balanceMg: 600 }).where(eq(mockCustomers.id, 'HC-204934'));

  // Requests waiting for the customer to arrive (inventory untouched!).
  const open = [
    { id: 'HG-10025', cust: 0, code: 'KRT', mg: 4200, pickup: '482913', minutesAgo: 95 },
    { id: 'HG-10026', cust: 1, code: 'KRT', mg: 7850, pickup: '193577', minutesAgo: 60 * 20 },
    { id: 'HG-10027', cust: 2, code: 'KRT', mg: 3100, pickup: '640218', minutesAgo: 40 },
    { id: 'HG-10028', cust: 3, code: 'OMD', mg: 10500, pickup: '775104', minutesAgo: 130 },
    { id: 'HG-10029', cust: 4, code: 'BHR', mg: 5000, pickup: '208866', minutesAgo: 60 * 26 },
    { id: 'HG-10030', cust: 5, code: 'PZU', mg: 2600, pickup: '531190', minutesAgo: 70 },
  ];
  for (const o of open) {
    const c = HASAD_CUSTOMERS[o.cust];
    const b = branch[o.code];
    const requestedAt = new Date(now.getTime() - o.minutesAgo * 60_000);
    const receivedAt = new Date(requestedAt.getTime() + 45_000);
    await db.insert(mockWithdrawals).values({ id: o.id, customerId: c.id, weightMg: o.mg, karat: 21, branchCode: b.hasadBranchCode!, status: 'READY_FOR_PICKUP', pickupCode: o.pickup, requestedAt, updatedAt: requestedAt });
    await db.insert(t.hasadWithdrawals).values({
      externalId: o.id, hasadCustomerId: c.id, customerName: c.fullName, customerNameAr: c.fullNameAr, customerPhone: c.phone, customerNationalIdMasked: c.nid,
      entitledWeightMg: o.mg, entitlementKarat: 21, branchId: b.id, status: 'READY_FOR_PICKUP', externalStatus: 'READY_FOR_PICKUP', pickupCode: o.pickup, requestedAt, receivedAt, lastSyncedAt: receivedAt,
    });
    await writeAudit(db, null, { action: 'HASAD_WITHDRAWAL_RECEIVED', entityType: 'hasad_withdrawal', entityId: o.id, branchId: b.id, at: receivedAt, key: 'Withdrawal {id} received from Hasad Gold: {customer}, {weight} entitlement. No inventory reserved.', params: { id: o.id, customer: ap.text(c.fullName, c.fullNameAr), weight: ap.mg(o.mg) } });
  }
  // Still accumulating / awaiting Hasad approval — not yet sent to the ERP.
  await db.insert(mockWithdrawals).values({ id: 'HG-10031', customerId: HASAD_CUSTOMERS[6].id, weightMg: 6000, karat: 21, branchCode: branch.KRT.hasadBranchCode!, status: 'PENDING', requestedAt: new Date(now.getTime() - 15 * 60_000) });

  // ───────── session history & live presence ─────────
  const subnet: Record<string, string> = { KRT: '10.20.1', OMD: '10.20.2', BHR: '10.20.3', PZU: '10.20.4' };
  const uaDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
  const uaEdge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0';
  const uaTablet = 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
  const uaMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const ipFor = (u: (typeof USERS)[number]) => (u.branch ? `${subnet[u.branch]}.${10 + USERS.indexOf(u)}` : '10.20.0.5');
  const uaFor = (u: (typeof USERS)[number]) => (u.role === 'GENERAL_MANAGER' ? uaMac : u.role === 'BRANCH_MANAGER' ? uaEdge : uaDesktop);

  for (let off = -30; off <= 0; off++) {
    const weekday = new Date(at(off, 12)).getUTCDay();
    for (const u of USERS) {
      if (weekday === 5 && u.branch !== 'KRT') continue;
      if (u.role === 'GENERAL_MANAGER' && !chance(0.6)) continue;
      const a = actors[u.username];
      const loginAt = at(off, 8, int(20, 55));
      if (off === 0) {
        if (!['KRT'].includes(u.branch ?? '') || loginAt.getTime() > now.getTime() - 10 * 60_000) continue;
      }
      const endAt = off === 0 ? new Date(now.getTime() - int(2, 6) * 60_000) : at(off, int(17, 21), int(0, 59));
      const id = hashToken(`hist-${u.username}-${off}`);
      await db.insert(t.sessions).values({
        id, userId: a.userId, branchId: a.branchId, loginAt, lastActivityAt: endAt, userAgent: uaFor(u), device: uaFor(u) === uaMac ? 'Safari on macOS' : uaFor(u) === uaEdge ? 'Edge on Windows' : 'Chrome on Windows',
        ipAddress: ipFor(u), currentModule: u.role === 'CASHIER' ? 'pos' : 'dashboard', status: 'LOGGED_OUT', endedAt: endAt, endedReason: off === 0 ? 'Shift handover' : 'User signed out',
      });
      const withSession = { ...a, sessionId: id, ip: ipFor(u) };
      await writeAudit(db, withSession, { action: 'LOGIN', entityType: 'session', entityId: `S-${id.slice(0, 8).toUpperCase()}`, at: loginAt, key: '{name} ({username}) signed in', params: { name: ap.text(a.fullName, a.fullNameAr), username: a.username } });
      await writeAudit(db, withSession, { action: 'LOGOUT', entityType: 'session', entityId: `S-${id.slice(0, 8).toUpperCase()}`, at: endAt, key: '{name} ({username}) signed out', params: { name: ap.text(a.fullName, a.fullNameAr), username: a.username } });
    }
  }

  // Live (simulated) sessions at other branches so "Active Users" is meaningful during a demo.
  const live: { user: string; ua: string; ip: string; module: string; minutesAgoLogin: number; minutesIdle: number }[] = [
    { user: 'cashier.omd.01', ua: uaTablet, ip: '10.20.2.21', module: 'pos', minutesAgoLogin: 140, minutesIdle: 1 },
    { user: 'branch.manager.omd', ua: uaEdge, ip: '10.20.2.14', module: 'dashboard', minutesAgoLogin: 190, minutesIdle: 26 },
    { user: 'cashier.bhr.01', ua: uaDesktop, ip: '10.20.3.17', module: 'hasad', minutesAgoLogin: 95, minutesIdle: 2 },
    { user: 'branch.manager.bhr', ua: uaEdge, ip: '10.20.3.16', module: 'expenses', minutesAgoLogin: 120, minutesIdle: 4 },
    { user: 'cashier.pzu.01', ua: uaDesktop, ip: '10.20.4.19', module: 'pos', minutesAgoLogin: 180, minutesIdle: 3 },
    // Same account signed in on a second device elsewhere → flagged as concurrent.
    { user: 'cashier.pzu.01', ua: uaTablet, ip: '10.20.9.77', module: 'pos', minutesAgoLogin: 22, minutesIdle: 1 },
  ];
  for (const l of live) {
    const a = actors[l.user];
    const loginAt = new Date(now.getTime() - l.minutesAgoLogin * 60_000);
    const s = await createSession(db, { userId: a.userId, branchId: a.branchId, userAgent: l.ua, ip: l.ip, absoluteHours: DEFAULT_SETTINGS.security.sessionAbsoluteHours, at: loginAt });
    await db
      .update(t.sessions)
      .set({ loginAt, lastActivityAt: new Date(now.getTime() - l.minutesIdle * 60_000), currentModule: l.module, isSimulated: true })
      .where(eq(t.sessions.id, s.id));
    await writeAudit(db, { ...a, sessionId: s.id, ip: l.ip }, { action: 'LOGIN', entityType: 'session', entityId: `S-${s.id.slice(0, 8).toUpperCase()}`, at: loginAt, key: '{name} ({username}) signed in', params: { name: ap.text(a.fullName, a.fullNameAr), username: a.username } });
  }
  // A couple of failed sign-in attempts to show security monitoring.
  for (const m of [48, 47]) {
    await writeAudit(db, null, { action: 'LOGIN_FAILED', entityType: 'user', entityId: 'cashier.kh.02', branchId: branch.KRT.id, at: new Date(now.getTime() - m * 60_000), key: 'Failed login attempt for “{username}” from {ip}', params: { username: 'cashier.kh.02', ip: '10.20.1.77' } });
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(t.jewelryItems).where(eq(t.jewelryItems.status, 'AVAILABLE'));
  return { availableItems: Number(n) };
}
