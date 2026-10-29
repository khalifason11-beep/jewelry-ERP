// UX-3: the re-confirmation window seen from the screens. The server decides (GET /auth/reauth); nothing here skips
// a factor: these helpers only ask earlier (at the start of a flow) or reuse a password the person just typed.

import { get, post, stepUp } from './api';
import { getPasskey, type PublicKeyCredentialRequestOptionsJSON } from './webauthn';

export interface ReauthStatus {
  password: boolean;
  passkey: boolean;
  hasPasskey: boolean;
  windowMinutes: number;
  passwordUntil: string | null;
  passkeyUntil: string | null;
}

/** Confirm with a passkey on the signed-in session (opens the passkey half of the window). */
export async function confirmWithPasskey(): Promise<{ uv: boolean }> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>('/auth/reauth/passkey/options');
  const response = await getPasskey(options);
  return post<{ uv: boolean }>('/auth/reauth/passkey/verify', { response });
}

/** What is still missing for a protected action now, or soon: a factor counts as missing when less than `keep` of the window is left. */
export function missing(s: ReauthStatus, now: number, keep = 0): { password: boolean; passkey: boolean } {
  const left = (until: string | null) => (until ? new Date(until).getTime() - now : -1);
  const need = s.windowMinutes * 60_000 * keep;
  return { password: !s.password || left(s.passwordUntil) < need, passkey: s.hasPasskey && (!s.passkey || left(s.passkeyUntil) < need) };
}

/**
 * At the start of a multi-step flow (karats and rates, a branch and its users, funding): ask once now, in the one
 * dialog, when less than half of the window is left, so the steps that follow run inside one window. Resolves false
 * when the person cancels (the flow then stops before anything is typed).
 */
export async function ensureFresh(keep = 0.5): Promise<boolean> {
  const s = await get<ReauthStatus>('/auth/reauth');
  const needs = missing(s, Date.now(), keep);
  return needs.password || needs.passkey ? stepUp(needs) : true;
}

/**
 * A form that already asks for the password (seal, corrections, the rate guard) opens the window with it, so the
 * protected request that follows never asks for it a second time; the passkey follows at once for those who have one.
 */
export async function openWindowWith(password: string): Promise<void> {
  await post('/auth/reauth', { password });
  const s = await get<ReauthStatus>('/auth/reauth');
  if (s.hasPasskey && !s.passkey) await confirmWithPasskey();
}
