// Second-factor state and protections (Phase 2fa, D-2fa-*): who must use a second factor, whether a
// user is enrolled, the reserve-then-verify lockout for failed second-factor attempts (the same
// pattern as passwords, D-2a-10), recovery codes, and the record of every successful sign-in.

import { randomInt } from 'node:crypto';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import type { SignInMethod, SystemSettings } from '@jerp/shared';
import { describeDevice } from '../modules/sessions/service';

type Security = SystemSettings['security'];

export interface FactorState {
  /** The user's role is in security.twoFactorRequiredRoles. */
  required: boolean;
  /** Active (not revoked) passkeys. */
  credentials: number;
  /** Unused recovery codes of the current set. */
  recoveryRemaining: number;
  /** The current set was confirmed as saved ("I saved them"). */
  recoveryAcknowledged: boolean;
  /** Sign-in needs a second step (passkey or recovery code). */
  secondStepAtLogin: boolean;
  /** Required role, but no passkey or no confirmed recovery codes yet: nothing else is allowed. */
  enrollmentRequired: boolean;
}

export async function activeCredentialCount(exec: Executor, userId: number): Promise<number> {
  const [r] = await exec.select({ n: count() }).from(t.webauthnCredentials).where(and(eq(t.webauthnCredentials.userId, userId), isNull(t.webauthnCredentials.revokedAt)));
  return Number(r.n);
}

export async function factorState(exec: Executor, userId: number, roleCode: string, security: Security): Promise<FactorState> {
  const [u] = await exec
    .select({ gen: t.users.recoveryCodesGeneratedAt, ack: t.users.recoveryCodesAcknowledgedAt })
    .from(t.users)
    .where(eq(t.users.id, userId));
  const credentials = await activeCredentialCount(exec, userId);
  const [r] = await exec
    .select({ n: count() })
    .from(t.recoveryCodes)
    .where(and(eq(t.recoveryCodes.userId, userId), isNull(t.recoveryCodes.usedAt), isNull(t.recoveryCodes.invalidatedAt)));
  const recoveryRemaining = Number(r.n);
  const recoveryAcknowledged = !!u?.gen && !!u?.ack && u.ack >= u.gen;
  const required = (security.twoFactorRequiredRoles as string[]).includes(roleCode);
  return {
    required,
    credentials,
    recoveryRemaining,
    recoveryAcknowledged,
    // Anyone enrolled (passkey, or confirmed recovery codes after a "this wasn't me") gets the second step.
    secondStepAtLogin: credentials > 0 || (recoveryAcknowledged && recoveryRemaining > 0),
    enrollmentRequired: required && (credentials === 0 || !recoveryAcknowledged),
  };
}

// ───────── lockout of the second factor (reserve, then verify) ─────────

export type MfaReservation = { allowed: false } | { allowed: true; failed: number; lockedUntil: Date | null };

/**
 * Atomically reserve one failed second-factor attempt BEFORE verifying anything (D-2fa-6). While
 * locked nothing is reserved and nothing is verified; the attempt that reaches the threshold sets
 * the lock in the same statement, so a burst gets at most `lockoutThreshold` verifications.
 */
export async function reserveMfaAttempt(exec: Executor, userId: number, s: Security): Promise<MfaReservation> {
  const next = sql`${t.users.mfaFailedCount} + 1`;
  const lockMins = sql`LEAST(${s.lockoutMaxMinutes}, ${s.lockoutBaseMinutes} * power(2, LEAST(${next} - ${s.lockoutThreshold}, 20)))::int`;
  const [row] = await exec
    .update(t.users)
    .set({
      mfaFailedCount: next,
      mfaLockedUntil: sql`CASE WHEN ${next} >= ${s.lockoutThreshold} THEN now() + make_interval(mins => ${lockMins}) ELSE NULL END`,
    })
    .where(sql`${t.users.id} = ${userId} AND (${t.users.mfaLockedUntil} IS NULL OR ${t.users.mfaLockedUntil} <= now())`)
    .returning({ failed: t.users.mfaFailedCount, lockedUntil: t.users.mfaLockedUntil });
  if (!row) return { allowed: false };
  return { allowed: true, failed: row.failed, lockedUntil: row.lockedUntil ? new Date(row.lockedUntil) : null };
}

export async function clearMfaFailures(exec: Executor, userId: number): Promise<void> {
  await exec.update(t.users).set({ mfaFailedCount: 0, mfaLockedUntil: null }).where(eq(t.users.id, userId));
}

// ───────── recovery codes ─────────

/** No look-alike characters (0/O, 1/I/L, U/V). 10 characters ≈ 49 bits, shown as XXXXX-XXXXX. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** What the user typed → canonical form (spaces, dashes and case ignored). */
export function normaliseRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{10}$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

// ───────── sign-in record ─────────

/** Approximate address for display: IPv4 /24, IPv6 /48. */
export function approximateIp(ip: string | undefined | null): string | null {
  if (!ip || ip === 'unknown') return null;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean).slice(0, 3);
    return `${parts.join(':')}::/48`;
  }
  return null;
}

const NEW_DEVICE_DAYS = 30;

/**
 * Record a successful sign-in. It is a NEW device when the user has earlier sign-ins but none in the
 * last 30 days with this passkey, or none with this browser label.
 */
export async function recordSignIn(
  exec: Executor,
  e: { userId: number; sessionId: string; method: SignInMethod; credential?: { id: number; nickname: string } | null; userAgent?: string; ip?: string; uv: boolean | null; at?: Date },
): Promise<{ newDevice: boolean }> {
  const at = e.at ?? new Date();
  const since = new Date(at.getTime() - NEW_DEVICE_DAYS * 86_400_000);
  const browser = describeDevice(e.userAgent);
  const recent = await exec
    .select({ credentialId: t.signInEvents.credentialId, browser: t.signInEvents.browser })
    .from(t.signInEvents)
    .where(and(eq(t.signInEvents.userId, e.userId), gte(t.signInEvents.at, since)))
    .orderBy(desc(t.signInEvents.at))
    .limit(500);
  const [any] = await exec.select({ n: count() }).from(t.signInEvents).where(eq(t.signInEvents.userId, e.userId));
  const hasHistory = Number(any.n) > 0;
  const credentialSeen = !e.credential || recent.some((r) => r.credentialId === e.credential!.id);
  const browserSeen = recent.some((r) => r.browser === browser);
  const newDevice = hasHistory && (!credentialSeen || !browserSeen);
  await exec.insert(t.signInEvents).values({
    userId: e.userId,
    sessionId: e.sessionId,
    method: e.method,
    credentialId: e.credential?.id ?? null,
    credentialNickname: e.credential?.nickname ?? null,
    browser,
    ipApprox: approximateIp(e.ip),
    uv: e.uv,
    newDevice,
    at,
  });
  return { newDevice };
}
