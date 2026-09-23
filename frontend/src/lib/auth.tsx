import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@jerp/shared';
import { ApiError, get, onAuthError, post } from './api';

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
  company: { name: string; nameAr: string; currency: string; timezone: string };
  allowSelfPasswordChange: boolean;
  maxDiscountPercent: number;
  hasadMode: 'MOCK' | 'LIVE';
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
        return await get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(
    () =>
      onAuthError((e) => {
        if (e.status === 401) qc.setQueryData(['me'], null);
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
      // Drop the previous user's cached data but keep the live `me` query observed by this provider.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], res);
      return res;
    },
    logout: async () => {
      try {
        await post('/auth/logout');
      } finally {
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
