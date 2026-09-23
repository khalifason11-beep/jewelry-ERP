// Thin fetch wrapper. Sends the current module so the server can show it in Active Sessions.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
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
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? res.statusText, data?.error?.details);
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
