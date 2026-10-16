// SAFE-1: nothing secret ever reaches the logs, and every API request leaves exactly one line with its request id.
// The real server runs as a child process with LOG_LEVEL=debug (everything is written); the test signs in (one wrong
// password first), records a sale with an Idempotency-Key, triggers an error, then scans every line the server wrote
// for the password, the session cookie, the CSRF token and the idempotency key. Real PostgreSQL only (test/pg).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { t, type DatabaseHandle } from '@jerp/database';
import { createContext } from '../../src/bootstrap';
import { seedWorld } from '../fixtures/world';
import { DEMO_PASSWORDS } from '../fixtures/world-data';
import { openTestDatabase, PG_MODE } from '../helpers';
import { startServer, type ServerProcess } from './server-process';

let handle: DatabaseHandle & { url?: string };
let srv: ServerProcess;

beforeAll(async () => {
  if (!PG_MODE) throw new Error('test/pg/** must run in the postgres project');
  handle = await openTestDatabase();
  await seedWorld(createContext(handle));
  srv = await startServer(handle.url!, { LOG_LEVEL: 'debug' });
}, 120_000);
afterAll(async () => {
  srv?.child.kill('SIGTERM');
  await srv?.exited;
  await handle?.close();
});

describe('logs', () => {
  it('a sign-in and a sale leave no secret in the logs, and one line per request with its request id', async () => {
    const password = DEMO_PASSWORDS.CASHIER;
    const wrong = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cashier.kh.01', password: 'Wrong-Secret-Pw-777' }) });
    expect(wrong.status).toBe(401);
    const login = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cashier.kh.01', password }) });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('jerp_session='))!;
    const cookieValue = sessionCookie.split('=')[1];
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const [u] = await handle.db.select().from(t.users).where(eq(t.users.username, 'cashier.kh.01'));
    const [item] = await handle.db.select({ id: t.jewelryItems.id }).from(t.jewelryItems).where(and(eq(t.jewelryItems.branchId, u.branchId!), eq(t.jewelryItems.status, 'AVAILABLE'))).limit(1);
    const idemKey = randomUUID();
    const sale = await fetch(`${srv.base}/api/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: sessionCookie, 'x-csrf-token': csrfToken, 'idempotency-key': idemKey },
      body: JSON.stringify({ items: [{ itemId: item.id }], paymentMethod: 'CASH' }),
    });
    expect(sale.status).toBe(200);
    const saleId = sale.headers.get('x-request-id');
    expect(saleId).toMatch(/^[0-9a-f-]{36}$/);

    // An error answer: a code in the body, the request id in the X-Request-Id header (the body stays identical for the
    // sign-in refusals: no enumeration channel), never a stack trace.
    const bad = await fetch(`${srv.base}/api/sales`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie, 'x-csrf-token': csrfToken, 'idempotency-key': randomUUID() }, body: '{"items":' });
    const badBody = (await bad.json()) as { error: Record<string, unknown> };
    expect(badBody.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(badBody)).not.toMatch(/\bat \w|\.ts:\d|node_modules|stack/i);
    const unknown = await fetch(`${srv.base}/api/no-such-thing`);
    expect(unknown.status).toBe(404);
    const unknownId = unknown.headers.get('x-request-id');

    await new Promise((r) => setTimeout(r, 300)); // let the last lines flush
    const logs = srv.output();
    for (const [what, secret] of [['password', password], ['wrong password', 'Wrong-Secret-Pw-777'], ['session cookie', cookieValue], ['CSRF token', csrfToken], ['idempotency key', idemKey]] as const) {
      expect(logs.includes(secret), `${what} found in the logs`).toBe(false);
    }
    // Every line is JSON; the sale's request has exactly one access line carrying its id.
    const lines = logs.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.msg === 'request' && l.requestId === saleId)).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'request' && l.requestId === unknownId && l.status === 404)).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'request').every((l) => typeof l.requestId === 'string')).toBe(true);
  }, 60_000);
});
