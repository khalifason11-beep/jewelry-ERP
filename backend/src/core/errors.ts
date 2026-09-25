// User-facing errors carry a stable English *key* (a template with {placeholders}) plus params.
// The API returns both, so the UI can translate the key (see frontend/src/lib/i18n-ar.ts) and
// fill in the params. `message` is the interpolated English text (logs, API clients, tests).

export type ErrorParams = Record<string, string | number | null | undefined>;

export function interpolate(template: string, params?: ErrorParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
}

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly key: string,
    public readonly params?: ErrorParams,
    public readonly details?: unknown,
  ) {
    super(interpolate(key, params));
  }
}

export const badRequest = (key: string, params?: ErrorParams, details?: unknown) => new AppError(400, 'BAD_REQUEST', key, params, details);
export const unauthorized = (key = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', key);
export const forbidden = (key = 'You do not have permission to perform this action', params?: ErrorParams) =>
  new AppError(403, 'FORBIDDEN', key, params);
/** `what` must be a fixed noun (e.g. 'Sale') so the resulting key is stable: "Sale not found". */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (key: string, params?: ErrorParams, details?: unknown) => new AppError(409, 'CONFLICT', key, params, details);
