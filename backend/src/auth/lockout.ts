// Sign-in throttling (security item 3, docs/decisions.md D-1a-4).
//   * Per account: after `lockoutThreshold` consecutive failures the account is locked for
//     `lockoutBaseMinutes`; every further failure doubles the lock, capped at `lockoutMaxMinutes`.
//   * RESERVE, THEN VERIFY (D-2a-10): an attempt first reserves a failure atomically in the
//     database; the attempt that reaches the threshold sets the lock in that same statement, so a
//     burst of parallel attempts can never get more than `lockoutThreshold` passwords verified.
//     A correct password then clears the counter; a wrong one keeps the reservation as the failure.
//   * Per IP: a sliding window of failed attempts stops password spraying across many accounts.
//     Same pattern: a slot is reserved before the password check and refunded on success.
//     In memory, per process (see decisions D-1a-4 for multi-instance deployments).
//   * Unknown usernames and locked accounts get exactly the same response as a wrong password
//     (D-2a-12), so responses never reveal whether an account exists or is locked.

import { eq, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import type { SystemSettings } from '@jerp/shared';
import { AppError } from '../core/errors';

type Security = SystemSettings['security'];

export const IP_WINDOW_MS = 15 * 60_000;
export const IP_MAX_FAILURES = 30;

/** Lock duration (minutes) after `failed` consecutive failures; 0 = not locked. */
export function lockMinutes(failed: number, s: Pick<Security, 'lockoutThreshold' | 'lockoutBaseMinutes' | 'lockoutMaxMinutes'>): number {
  if (failed < s.lockoutThreshold) return 0;
  const steps = Math.min(failed - s.lockoutThreshold, 20);
  return Math.min(s.lockoutMaxMinutes, s.lockoutBaseMinutes * 2 ** steps);
}

export const accountLocked = () => new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
export const ipThrottled = () => new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts from this network. Try again later.');

// ───────── known accounts (database) ─────────

export type Reservation = { allowed: false } | { allowed: true; failed: number; lockedUntil: Date | null };

/**
 * Atomically reserve one failed attempt BEFORE the password is verified. Refused (nothing
 * reserved, nothing to verify) while the account is locked. When the reservation reaches the
 * threshold, the lock is set in the same statement: concurrent attempts see it at once.
 */
export async function reserveAttempt(exec: Executor, userId: number, s: Security): Promise<Reservation> {
  const next = sql`${t.users.failedLoginCount} + 1`;
  const lockMins = sql`LEAST(${s.lockoutMaxMinutes}, ${s.lockoutBaseMinutes} * power(2, LEAST(${next} - ${s.lockoutThreshold}, 20)))::int`;
  const [row] = await exec
    .update(t.users)
    .set({
      failedLoginCount: next,
      lockedUntil: sql`CASE WHEN ${next} >= ${s.lockoutThreshold} THEN now() + make_interval(mins => ${lockMins}) ELSE NULL END`,
    })
    .where(sql`${t.users.id} = ${userId} AND (${t.users.lockedUntil} IS NULL OR ${t.users.lockedUntil} <= now())`)
    .returning({ failed: t.users.failedLoginCount, lockedUntil: t.users.lockedUntil });
  if (!row) return { allowed: false };
  return { allowed: true, failed: row.failed, lockedUntil: row.lockedUntil ? new Date(row.lockedUntil) : null };
}

/** The password was correct: forget the consecutive failures (and a provisional lock). */
export async function clearFailures(exec: Executor, userId: number): Promise<void> {
  await exec.update(t.users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(t.users.id, userId));
}

// ───────── per IP (in memory) ─────────
const ipFailures = new Map<string, number[]>();

/**
 * Reserve a failure slot for `ip` before the password check. Returns null when the IP has used
 * its allowance (refuse without verifying), otherwise a function that refunds the slot (call it
 * when the password turned out to be correct). Synchronous: no await between check and reserve.
 */
export function ipReserve(ip: string, now = Date.now()): (() => void) | null {
  if (ipFailures.size > 50_000) ipFailures.clear();
  const list = (ipFailures.get(ip) ?? []).filter((ts) => now - ts < IP_WINDOW_MS);
  if (list.length >= IP_MAX_FAILURES) {
    ipFailures.set(ip, list);
    return null;
  }
  list.push(now);
  ipFailures.set(ip, list);
  let refunded = false;
  return () => {
    if (refunded) return;
    refunded = true;
    const cur = ipFailures.get(ip);
    const i = cur?.indexOf(now) ?? -1;
    if (cur && i >= 0) cur.splice(i, 1);
  };
}

/** Test helper: forget in-memory counters. */
export function resetThrottleMemory(): void {
  ipFailures.clear();
}
