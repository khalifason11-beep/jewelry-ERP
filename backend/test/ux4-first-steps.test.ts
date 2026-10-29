// UX-4 (docs/plans/UX-4.md §2.5): an empty point-of-sale page says when the branch's opening balance is still a draft.
// `openingDraft` comes only on an empty page and only for the branch the page was confined to (a branch-bound user's
// own branch, whatever the query asks).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createApp } from '../src/app';
import { createContext } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { createBranch } from '../src/modules/branches/service';
import { createOpening } from '../src/modules/openings/service';
import { seedWorld } from './fixtures/world';
import { DEMO_PASSWORDS } from './fixtures/world-data';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;
let app: ReturnType<typeof createApp>;
type Agent = ReturnType<typeof request.agent>;

async function login(username: string, role: keyof typeof DEMO_PASSWORDS): Promise<Agent> {
  const agent = request.agent(app) as unknown as Agent;
  const res = await agent.post('/api/auth/login').send({ username, password: DEMO_PASSWORDS[role] });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
  await seedWorld(ctx);
  app = createApp(ctx, loadConfig({ APP_MODE: 'demo', VITEST: '1' } as NodeJS.ProcessEnv));
});
afterAll(async () => handle?.close());

describe('UX-4: openingDraft on an empty items page', () => {
  it('true for an empty branch with a draft opening; false once there is none; absent when the page has pieces', async () => {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
    const gm = (await loadActor(ctx.db, u.id, null))!;
    const empty = await createBranch(ctx, gm, { code: 'UXF', name: 'First steps', nameAr: 'فرع الخطوات', city: 'Test' });
    const agent = await login('general.manager', 'GENERAL_MANAGER');
    const page = async (branchId: number) => (await agent.get('/api/inventory/items').query({ branchId, status: 'AVAILABLE,RESERVED' })).body;
    expect(await page(empty.id)).toMatchObject({ rows: [], openingDraft: false });
    const o = await createOpening(ctx, gm, { branchId: empty.id });
    expect(await page(empty.id)).toMatchObject({ rows: [], openingDraft: true });
    await ctx.db.update(t.openings).set({ status: 'SEALED', sealedAt: new Date(), sealedBy: gm.userId }).where(eq(t.openings.id, o.id));
    expect(await page(empty.id)).toMatchObject({ rows: [], openingDraft: false });
    const krt = (await ctx.db.select().from(t.branches).where(eq(t.branches.code, 'KRT')))[0].id;
    const stocked = await page(krt);
    expect(stocked.rows.length).toBeGreaterThan(0);
    expect(stocked).not.toHaveProperty('openingDraft');
  });

  it('a branch-bound user learns nothing about another branch: the page is their own branch', async () => {
    const [u] = await ctx.db.select().from(t.users).where(eq(t.users.username, 'general.manager'));
    const gm = (await loadActor(ctx.db, u.id, null))!;
    const other = await createBranch(ctx, gm, { code: 'UXG', name: 'Other', nameAr: 'فرع آخر', city: 'Test' });
    await createOpening(ctx, gm, { branchId: other.id });
    const cashier = await login('cashier.kh.01', 'CASHIER');
    const res = await cashier.get('/api/inventory/items').query({ branchId: other.id, status: 'AVAILABLE,RESERVED' });
    // Either refused, or the cashier's own (stocked) branch: never the other branch's draft.
    if (res.status === 200) {
      expect(res.body.rows.every((r: { branchId: number }) => r.branchId !== other.id)).toBe(true);
      expect(res.body.openingDraft).not.toBe(true);
    } else expect(res.status).toBe(403);
  });
});
