// WebAuthn plumbing (Phase 2fa, D-2fa-*). All cryptographic verification is done by
// @simplewebauthn/server; this module only adds what the library leaves to the application:
//
//   * the relying party (RP ID + expected origin) — from configuration in production;
//   * single-use challenges stored HASHED server-side, bound to the user AND to the session
//     (registration, step-up) or the pending sign-in (login), expiring after 5 minutes;
//   * mapping library errors to short reason codes (their messages contain the challenge, which
//     must never reach a log or the audit trail).

import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { t, type Executor } from '@jerp/database';
import type { WebauthnChallengePurpose } from '@jerp/shared';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Config } from '../config';

export const CHALLENGE_TTL_MS = 5 * 60_000;
/** Browser ceremony timeout (what the browser shows), inside the server-side TTL. */
export const CEREMONY_TIMEOUT_MS = 2 * 60_000;

export interface RelyingParty {
  rpId: string;
  rpName: string;
  origin: string;
}

/**
 * The relying party for this request. With APP_ORIGIN configured (always in production) it is fixed
 * by configuration. Demo / development without APP_ORIGIN (proxies rewrite hosts unpredictably,
 * see csrf.ts) derive it from the request's own Origin: acceptable there because the demo protects
 * nothing real; production refuses to start without a valid APP_ORIGIN / RP ID.
 */
export function relyingParty(config: Config, req: Request): RelyingParty {
  if (config.appOrigin) {
    return { rpId: config.webauthnRpId ?? new URL(config.appOrigin).hostname, rpName: config.webauthnRpName, origin: config.appOrigin };
  }
  let origin = `http://localhost:${config.port}`;
  const header = req.header('origin');
  if (header) {
    try {
      origin = new URL(header).origin;
    } catch {
      /* keep the default */
    }
  }
  const rpId = config.webauthnRpId ?? new URL(origin).hostname;
  return { rpId, rpName: config.webauthnRpName, origin };
}

const hash = (challenge: string) => createHash('sha256').update(challenge).digest('hex');

/** Store a freshly generated challenge (hashed). Exactly one of sessionId / pendingId. */
export async function storeChallenge(
  exec: Executor,
  c: { purpose: WebauthnChallengePurpose; userId: number; sessionId?: string; pendingId?: string; challenge: string; rp: RelyingParty; nickname?: string },
): Promise<void> {
  // Housekeeping: drop this user's expired or consumed challenges of the same purpose.
  await exec.delete(t.webauthnChallenges).where(and(eq(t.webauthnChallenges.userId, c.userId), sql`(${t.webauthnChallenges.expiresAt} <= now() OR ${t.webauthnChallenges.consumedAt} IS NOT NULL)`));
  await exec.insert(t.webauthnChallenges).values({
    purpose: c.purpose,
    userId: c.userId,
    sessionId: c.sessionId ?? null,
    pendingId: c.pendingId ?? null,
    challengeHash: hash(c.challenge),
    rpId: c.rp.rpId,
    origin: c.rp.origin,
    nickname: c.nickname ?? null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

/** The challenge a response claims to answer (from its clientDataJSON), or null if unreadable. */
export function challengeOf(response: { response?: { clientDataJSON?: unknown } }): string | null {
  try {
    const json = JSON.parse(Buffer.from(String(response.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof json.challenge === 'string' && json.challenge.length >= 16 ? json.challenge : null;
  } catch {
    return null;
  }
}

/**
 * Consume a challenge atomically: it must exist, belong to this user, purpose and binding, be
 * unexpired and unused. A second use (replay) or a parallel duplicate finds nothing.
 */
export async function consumeChallenge(
  exec: Executor,
  c: { purpose: WebauthnChallengePurpose; userId: number; sessionId?: string; pendingId?: string; challenge: string | null },
): Promise<{ rpId: string; origin: string; nickname: string | null; challenge: string } | null> {
  if (!c.challenge) return null;
  const [row] = await exec
    .update(t.webauthnChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(t.webauthnChallenges.challengeHash, hash(c.challenge)),
        eq(t.webauthnChallenges.purpose, c.purpose),
        eq(t.webauthnChallenges.userId, c.userId),
        c.sessionId ? eq(t.webauthnChallenges.sessionId, c.sessionId) : isNull(t.webauthnChallenges.sessionId),
        c.pendingId ? eq(t.webauthnChallenges.pendingId, c.pendingId) : isNull(t.webauthnChallenges.pendingId),
        isNull(t.webauthnChallenges.consumedAt),
        gt(t.webauthnChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ rpId: t.webauthnChallenges.rpId, origin: t.webauthnChallenges.origin, nickname: t.webauthnChallenges.nickname });
  return row ? { ...row, challenge: c.challenge } : null;
}

export type FailureReason =
  | 'CHALLENGE'
  | 'UNKNOWN_CREDENTIAL'
  | 'REVOKED_CREDENTIAL'
  | 'OTHER_USERS_CREDENTIAL'
  | 'ORIGIN'
  | 'RP_ID'
  | 'USER_VERIFICATION'
  | 'USER_PRESENCE'
  | 'COUNTER_REGRESSION'
  | 'SIGNATURE'
  | 'MALFORMED'
  | 'LOCKED'
  | 'INVALID_RECOVERY_CODE';

/** Library error → reason code. The raw message (it contains the challenge) is never kept. */
export function reasonOf(e: unknown): FailureReason {
  const m = String((e as Error)?.message ?? '');
  if (/counter value/i.test(m)) return 'COUNTER_REGRESSION';
  if (/user verification (was )?required|user could not be verified/i.test(m)) return 'USER_VERIFICATION';
  if (/user not present/i.test(m)) return 'USER_PRESENCE';
  if (/origin/i.test(m)) return 'ORIGIN';
  if (/rp ?id|rpIdHash|relying party/i.test(m)) return 'RP_ID';
  if (/challenge/i.test(m)) return 'CHALLENGE';
  if (/signature/i.test(m)) return 'SIGNATURE';
  return 'MALFORMED';
}

export const webauthn = {
  /** Wrapped so tests can count how many assertions really reach cryptographic verification. */
  verifyAssertion: (opts: Parameters<typeof verifyAuthenticationResponse>[0]) => verifyAuthenticationResponse(opts),
  verifyAttestation: (opts: Parameters<typeof verifyRegistrationResponse>[0]) => verifyRegistrationResponse(opts),
  registrationOptions: generateRegistrationOptions,
  authenticationOptions: generateAuthenticationOptions,
};

export type { AuthenticationResponseJSON, RegistrationResponseJSON };
