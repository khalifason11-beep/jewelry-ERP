// DOC-2 (go-live reset runbook, step 5): the bootstrap refuses an Arabic name that a console garbled ("????", U+FFFD,
// or UTF-8 read as a Windows code page), for the General Manager and for a branch, and creates nothing then. A real
// Arabic name passes. The runbook's way: bootstrap with the English name only; the General Manager types the Arabic
// name later in the app (they may edit their own row). Both projects.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../src/bootstrap';
import type { Ctx } from '../src/core/context';
import { loadActor } from '../src/modules/sessions/service';
import { updateUser } from '../src/modules/users/service';
import { bootstrapProduction, looksGarbledArabic, parseBranchArg } from '../src/modules/bootstrap/service';
import { openTestDatabase } from './helpers';

let handle: DatabaseHandle;
let ctx: Ctx;

beforeAll(async () => {
  handle = await openTestDatabase();
  ctx = createContext(handle);
});
afterAll(async () => handle?.close());

// "محمد" as UTF-8 bytes read as Windows-1252: what a Windows console sends without UTF-8.
const MOJIBAKE = Buffer.from('محمد أحمد', 'utf8').toString('latin1');

describe('a garbled Arabic name', () => {
  it('is recognised; real Arabic names pass', () => {
    for (const ok of ['محمد أحمد', 'عبد الله بن عمر', 'فرع الخرطوم 2', 'Ali علي']) expect(looksGarbledArabic(ok), ok).toBe(false);
    for (const bad of ['????', '???? ?????', '���', MOJIBAKE, 'Ù…Ø­Ù…Ø¯', 'Mohamed Ahmed', 'محمد ?']) expect(looksGarbledArabic(bad), bad).toBe(true);
  });

  it('the bootstrap refuses it (General Manager or branch) and creates nothing', async () => {
    const users = async () => (await ctx.db.select({ id: t.users.id }).from(t.users)).length;
    const before = await users();
    await expect(bootstrapProduction(ctx, { username: 'khalid.osman', fullName: 'Khalid Osman', fullNameAr: '???? ?????' })).rejects.toThrow(/arrived garbled/);
    await expect(bootstrapProduction(ctx, { username: 'khalid.osman', fullName: 'Khalid Osman', fullNameAr: MOJIBAKE })).rejects.toThrow(/arrived garbled/);
    await expect(bootstrapProduction(ctx, { username: 'khalid.osman', fullName: 'Khalid Osman', branches: [{ code: 'MAIN', name: 'Main', nameAr: '????', city: 'Khartoum' }] })).rejects.toThrow(/arrived garbled/);
    expect(() => parseBranchArg('MAIN:Main Branch:????:Khartoum')).toThrow(/arrived garbled/);
    expect(await users()).toBe(before);
  });

  it('the runbook way: English name at bootstrap, the Arabic name typed later by the General Manager', async () => {
    const res = await bootstrapProduction(ctx, { username: 'khalid.osman', fullName: 'Khalid Osman' });
    const [gm] = await ctx.db.select().from(t.users).where(eq(t.users.username, res.username));
    expect(gm.fullNameAr).toBeNull();
    const actor = (await loadActor(ctx.db, gm.id, null))!;
    await updateUser(ctx, actor, gm.id, { fullNameAr: 'خالد عثمان' });
    const [after] = await ctx.db.select().from(t.users).where(eq(t.users.id, gm.id));
    expect(after.fullNameAr).toBe('خالد عثمان');
  });
});
