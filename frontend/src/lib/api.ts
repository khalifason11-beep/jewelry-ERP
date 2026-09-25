// Thin fetch wrapper. Sends the current module so the server can show it in Active Sessions.

import { translate, type Params } from './i18n';

/**
 * API error. The server sends a stable English `key` (template) + `params`; `errorText()`
 * renders it in the current language. `message` is the English fallback.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public key?: string,
    public params?: Params,
  ) {
    super(message);
  }
}

/** Translate a param value when it is a known term (e.g. SOLD, AVAILABLE / RESERVED, a branch). */
function translateValue(v: Params[string]): Params[string] {
  if (typeof v !== 'string') return v;
  return v
    .split(' / ')
    .map((part) => translate(part))
    .join(' / ');
}

/** Translate every translatable param value (used for API errors and notifications). */
export function translateParams(params?: Params): Params | undefined {
  return params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, translateValue(v)])) : undefined;
}

/** User-facing text for any error, in the current language. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.key) {
      return translate(e.key, translateParams(e.params));
    }
    return translate(e.message);
  }
  if (e instanceof Error) return translate(e.message);
  return String(e);
}

let currentModule = 'app';
export function setCurrentModule(m: string) {
  currentModule = m;
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
export function onAuthError(l: Listener) {
  authListeners.add(l);
  return () => {
    authListeners.delete(l);
  };
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  let url = `/api${path}`;
  if (init.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'X-Client-Module': currentModule },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.', undefined, 'Cannot reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? res.statusText, data?.error?.details, data?.error?.key, data?.error?.params);
    if (res.status === 401 || err.code === 'PASSWORD_CHANGE_REQUIRED') authListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export const get = <T,>(path: string, query?: Record<string, unknown>) => api<T>(path, { query });
export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' });
