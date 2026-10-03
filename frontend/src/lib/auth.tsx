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
  hasadMode: 'MOCK' | 'LIVE';
  /** Payment methods offered at the counter (setting sales.posPaymentMethods). */
  posPaymentMethods: import('@jerp/shared').PaymentMethod[];
  /** Karats this deployment sells (setting inventory.allowedKarats). */
  allowedKarats: number[];
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  isGlobal: boolean;
  login: (username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const Ctx = createContext<AuthCtx | null>(null);

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
          setCsrfToken(null);
          qc.setQueryData(['me'], null);
        }
        if (e.code === 'PASSWORD_CHANGE_REQUIRED') qc.invalidateQueries({ queryKey: ['me'] });
      }),
    [qc],
  );

  const me = q.data ?? null;
  const perms = new Set(me?.user.permissions ?? []);
  const value: AuthCtx = {
    me,
    loading: q.isLoading,
    can: (p) => perms.has(p),
    isGlobal: perms.has('scope.all_branches'),
    login: async (username, password) => {
      const res = await post<Me>('/auth/login', { username, password });
      setCsrfToken(res.csrfToken);
      // Drop the previous user's cached data but keep the live `me` query observed by this provider.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], res);
      return res;
    },
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
