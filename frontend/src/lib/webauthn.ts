// Passkeys in the browser (Phase 2fa). Thin wrappers over @simplewebauthn/browser that turn every
// browser failure into one plain-language message (translation key). Verification happens on the
// server only; nothing here is trusted.

import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';

export type PasskeyProblem = 'INSECURE_CONTEXT' | 'UNSUPPORTED' | 'CANCELLED' | 'ALREADY_REGISTERED' | 'WRONG_SITE' | 'FAILED';

/** A browser-side passkey failure; `key` is an English translation key. */
export class PasskeyError extends Error {
  constructor(public problem: PasskeyProblem) {
    super(PROBLEM_TEXT[problem]);
  }
  get key() {
    return PROBLEM_TEXT[this.problem];
  }
}

export const PROBLEM_TEXT: Record<PasskeyProblem, string> = {
  INSECURE_CONTEXT: 'Passkeys only work on a secure connection (https). Open the system through its https address.',
  UNSUPPORTED: 'This browser does not support passkeys. Use an up-to-date Chrome, Edge, Safari or Firefox.',
  CANCELLED:
    'The request was cancelled or timed out. If no Windows Hello or security-key window appeared, this computer has no passkey device set up: use a USB security key or your phone.',
  ALREADY_REGISTERED: 'This device is already registered for your account.',
  WRONG_SITE: 'This address is not the one passkeys are registered for. Open the system through its usual address.',
  FAILED: 'The passkey request failed. Try again.',
};

/** Why passkeys cannot work here at all, or null when they can. */
export function passkeyUnavailable(): PasskeyProblem | null {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'INSECURE_CONTEXT';
  if (!browserSupportsWebAuthn()) return 'UNSUPPORTED';
  return null;
}

/** True when this computer has a built-in authenticator (Windows Hello, Touch ID…). */
export async function hasBuiltInAuthenticator(): Promise<boolean> {
  try {
    return await platformAuthenticatorIsAvailable();
  } catch {
    return false;
  }
}

function toProblem(e: unknown): PasskeyProblem {
  if (e instanceof WebAuthnError) {
    if (e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'ALREADY_REGISTERED';
    if (e.code === 'ERROR_INVALID_DOMAIN' || e.code === 'ERROR_INVALID_RP_ID') return 'WRONG_SITE';
    if (e.code === 'ERROR_CEREMONY_ABORTED') return 'CANCELLED';
  }
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'CANCELLED';
  if (name === 'InvalidStateError') return 'ALREADY_REGISTERED';
  if (name === 'SecurityError') return 'WRONG_SITE';
  if (name === 'NotSupportedError') return 'UNSUPPORTED';
  return 'FAILED';
}

function guard() {
  const p = passkeyUnavailable();
  if (p) throw new PasskeyError(p);
}

export async function createPasskey(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
  guard();
  try {
    return await startRegistration({ optionsJSON: options });
  } catch (e) {
    throw new PasskeyError(toProblem(e));
  }
}

export async function getPasskey(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
  guard();
  try {
    return await startAuthentication({ optionsJSON: options });
  } catch (e) {
    throw new PasskeyError(toProblem(e));
  }
}

export type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON };
