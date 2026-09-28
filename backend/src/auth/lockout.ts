// Sign-in throttling (security item 3, docs/decisions.md D-1a-4).
//   * Per account: after `lockoutThreshold` consecutive failures the account is locked for
//     `lockoutBaseMinutes`; every further failure doubles the lock, capped at `lockoutMaxMinutes`.
//     The counter lives in the database (atomic increment), so parallel attempts are all counted.
//   * Unknown usernames follow the same rule in memory, so responses never reveal whether an
//     account exists.
//   * Per IP: a sliding window of failed attempts stops password spraying across many accounts.
//     In memory, per process (see decisions D-1a-4 for multi-instance deployments).

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

// ───────── unknown usernames (in memory) ─────────
const ghosts = new Map<string, { failed: number; lockedUntil: number }>();

export function ghostLocked(username: string, now = Date.now()): boolean {
  const g = ghosts.get(username);
  return !!g && g.lockedUntil > now;
}

export function ghostFailure(username: string, s: Security, now = Date.now()): void {
  if (ghosts.size > 10_000) {
    for (const [k, v] of ghosts) if (v.lockedUntil < now) ghosts.delete(k);
    if (ghosts.size > 10_000) ghosts.clear();
  }
  const g = ghosts.get(username) ?? { failed: 0, lockedUntil: 0 };
  g.failed += 1;
  const m = lockMinutes(g.failed, s);
  if (m) g.lockedUntil = now + m * 60_000;
  ghosts.set(username, g);
}

// ───────── known accounts (database) ─────────

/** Atomically count a failure; returns the new count and whether this failure started a lock. */
export async function recordFailure(exec: Executor, userId: number, s: Security): Promise<{ failed: number; lockedUntil: Date | null }> {
  const [row] = await exec
    .update(t.users)
    .set({ failedLoginCount: sql`${t.users.failedLoginCount} + 1` })
    .where(eq(t.users.id, userId))
    .returning({ failed: t.users.failedLoginCount });
  const m = lockMinutes(row.failed, s);
  if (!m) return { failed: row.failed, lockedUntil: null };
  const lockedUntil = new Date(Date.now() + m * 60_000);
  await exec.update(t.users).set({ lockedUntil }).where(eq(t.users.id, userId));
  return { failed: row.failed, lockedUntil };
}

export async function clearFailures(exec: Executor, userId: number): Promise<void> {
  await exec.update(t.users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(t.users.id, userId));
}

// ───────── per IP (in memory) ─────────
const ipFailures = new Map<string, number[]>();

export function ipBlocked(ip: string, now = Date.now()): boolean {
  const list = (ipFailures.get(ip) ?? []).filter((ts) => now - ts < IP_WINDOW_MS);
  if (list.length) ipFailures.set(ip, list);
  else ipFailures.delete(ip);
  return list.length >= IP_MAX_FAILURES;
}

export function ipFailure(ip: string, now = Date.now()): void {
  if (ipFailures.size > 50_000) ipFailures.clear();
  const list = ipFailures.get(ip) ?? [];
  list.push(now);
  ipFailures.set(ip, list.slice(-IP_MAX_FAILURES));
}

/** Test helper: forget in-memory counters. */
export function resetThrottleMemory(): void {
  ghosts.clear();
  ipFailures.clear();
}
