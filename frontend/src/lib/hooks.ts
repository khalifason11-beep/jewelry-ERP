import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Branch, Category } from './types';

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Branches the current user may access (all for global roles, own for others). */
export function useBranches() {
  return useQuery({ queryKey: ['branches'], queryFn: () => get<Branch[]>('/branches'), staleTime: 300_000 });
}

/** Directory of every branch name (for transfer destinations). */
export function useBranchDirectory() {
  return useQuery({ queryKey: ['branches', 'directory'], queryFn: () => get<Branch[]>('/branches/directory'), staleTime: 300_000 });
}

export function useCategories() {
  return useQuery({ queryKey: ['categories'], queryFn: () => get<Category[]>('/categories'), staleTime: 300_000 });
}

export function useGoldRates() {
  return useQuery({
    queryKey: ['gold-rates'],
    queryFn: () => get<{ current: Record<string, { pricePerGram: number; effectiveAt: string }>; history: { id: number; karat: number; pricePerGram: number; effectiveAt: string; setBy: string | null }[] }>('/gold-rates'),
  });
}

/** Branch colours follow the validated categorical order and never change with filters. */
export const BRANCH_COLORS = ['var(--color-series-1)', 'var(--color-series-2)', 'var(--color-series-3)', 'var(--color-series-4)'];
export const branchColor = (branchId: number) => BRANCH_COLORS[(branchId - 1) % BRANCH_COLORS.length];
