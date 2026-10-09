import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@jerp/shared';
import { ApiError, get, onAuthError, post, setCsrfToken } from './api';
import type { Branding } from './branding';

export interface Me {
  user: {
    id: number;
    username: string;
    fullName: string;
    fullNameAr: string | null;
    mustChangePassword: boolean;
    role: { code: string; name: string; nameAr: string };
    branch: { id: number; code: string; name: string; nameAr: string } | null;
    permissions: Permission[];
  };
  session: { ref: string; loginAt: string; device: string; ipAddress: string } | null;
  branding: Branding;
  timezone: string;
  appMode: 'demo' | 'production';
  csrfToken: string | null;
  allowSelfPasswordChange: boolean;
  maxDiscountPercent: number;
  /** Payment methods offered at the counter (setting sales.posPaymentMethods). */
  posPaymentMethods: import('@jerp/shared').PaymentMethod[];
  /** Karats this deployment sells (setting inventory.allowedKarats). */
  allowedKarats: number[];
  /** Printing settings (D-print-2). */
  print: { invoiceFormat: import('@jerp/shared').InvoiceFormat; receiptWidthMm: number; autoPrintAfterSale: boolean };
  /** Second factor (passkeys) for this account (Phase 2fa). */
  secondFactor: SecondFactor;
  /** LOCK-1: security-locked accounts this viewer may see (users.view; own branch for a manager). */
  lockedAccounts: LockedAccount[];
}

export interface LockedAccount {
  id: number;
  username: string;
  fullName: string;
  fullNameAr: string | null;
  lockedAt: string;
}

export interface SignInAlert {
  id: number;
  at: string;
  browser: string | null;
  credentialNickname: string | null;
  ipApprox: string | null;
  method: 'PASSWORD' | 'PASSKEY' | 'RECOVERY_CODE';
}

export interface SecondFactor {
  /** The role must use a second factor (security.twoFactorRequiredRoles). */
  required: boolean;
  /** Nothing else is allowed until a passkey is registered and recovery codes are saved. */
  enrollmentRequired: boolean;
  passkeys: number;
  recoveryCodesRemaining: number;
  recoveryCodesAcknowledged: boolean;
  userVerification: 'required' | 'preferred';
  requiredRoles: string[];
  signInMethod: 'PASSWORD' | 'PASSKEY' | 'RECOVERY_CODE';
  newDeviceAlert: SignInAlert | null;
}

/** Password accepted; a passkey or a recovery code must follow within a few minutes. */
export interface PendingSignIn {
  status: 'SECOND_FACTOR_REQUIRED';
  methods: ('PASSKEY' | 'RECOVERY_CODE')[];
  expiresAt: string;
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  isGlobal: boolean;
  login: (username: string, password: string) => Promise<Me | PendingSignIn>;
  /** Install the session returned by the second step of the sign-in. */
  signedIn: (me: Me) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const Ctx = createContext<AuthCtx | null>(null);

const SESSION_ENDED = 'jerp.sessionEnded';
/** Remembered for this tab only, so the sign-in page can say why the person is there. */
export function markSessionEnded() {
  try {
    sessionStorage.setItem(SESSION_ENDED, '1');
  } catch {
    /* storage unavailable: the sign-in page simply shows no note */
  }
}
export function clearSessionEnded() {
  try {
    sessionStorage.removeItem(SESSION_ENDED);
  } catch {
    /* ignore */
  }
}
export function sessionEnded(): boolean {
  try {
    return sessionStorage.getItem(SESSION_ENDED) === '1';
  } catch {
    return false;
  }
}

const ACCOUNT_LOCKED = 'jerp.accountLocked';
/**
 * LOCK-1 (D-lock-1): set only in the tab where the person has just confirmed "This wasn't me" and the server
 * answered that the account is now security-locked. The sign-in page of THAT tab explains the lock; nothing comes
 * from the server, so no other browser or tab can learn that an account is locked. Cleared by the next sign-in.
 */
export function markAccountLocked() {
  try {
    sessionStorage.setItem(ACCOUNT_LOCKED, '1');
  } catch {
    /* storage unavailable: the sign-in page shows no note */
  }
}
export function accountLockedHere(): boolean {
  try {
    return sessionStorage.getItem(ACCOUNT_LOCKED) === '1';
  } catch {
    return false;
  }
}
function clearAccountLocked() {
  try {
    sessionStorage.removeItem(ACCOUNT_LOCKED);
  } catch {
    /* ignore */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await get<Me>('/auth/me');
        setCsrfToken(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(
    () =>
      onAuthError((e) => {
        if (e.status === 401) {
          // UI-A2: a session that ended while signed in (expired, revoked) is explained on the sign-in page.
          if (qc.getQueryData(['me'])) markSessionEnded();
          setCsrfToken(null);
          qc.setQueryData(['me'], null);
        }
        if (e.code === 'PASSWORD_CHANGE_REQUIRED') qc.invalidateQueries({ queryKey: ['me'] });
      }),
    [qc],
  );

  const install = (res: Me) => {
    clearSessionEnded();
    clearAccountLocked();
    setCsrfToken(res.csrfToken);
    // Drop the previous user's cached data but keep the live `me` query observed by this provider.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(['me'], res);
  };
  const me = q.data ?? null;
  const perms = new Set(me?.user.permissions ?? []);
  const value: AuthCtx = {
    me,
    loading: q.isLoading,
    can: (p) => perms.has(p),
    isGlobal: perms.has('scope.all_branches'),
    login: async (username, password) => {
      const res = await post<Me | PendingSignIn>('/auth/login', { username, password });
      if ('status' in res) return res;
      install(res);
      return res;
    },
    signedIn: (res) => install(res),
    logout: async () => {
      try {
        await post('/auth/logout');
      } finally {
        setCsrfToken(null);
        qc.setQueryData(['me'], null);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      }
    },
    refresh: () => q.refetch(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider missing');
  return v;
}

export function homePath(me: Me): string {
  const p = new Set(me.user.permissions);
  if (p.has('dashboard.company')) return '/overview';
  if (p.has('dashboard.branch')) return '/dashboard';
  if (p.has('pos.access')) return '/pos';
  return '/me';
}
