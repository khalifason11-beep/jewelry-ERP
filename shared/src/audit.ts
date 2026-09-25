// Audit descriptions are stored as a translation key plus typed parameters so the UI can render
// them in the reader's language. Money and weights stay numeric; the client formats them.
// The plain-English `description` column is derived from the same key/params as a fallback.

export type AuditParam =
  | string
  | number
  | { money: number }
  | { mg: number }
  | { enum: string }
  | { karat: number }
  | { en: string; ar: string | null }
  | { list: AuditParam[] }
  | { key: string; params?: AuditParams };

export type AuditParams = Record<string, AuditParam>;

/** Constructors for typed audit parameters. */
export const ap = {
  money: (n: number): AuditParam => ({ money: n }),
  mg: (n: number): AuditParam => ({ mg: n }),
  enum: (code: string): AuditParam => ({ enum: code }),
  karat: (k: number): AuditParam => ({ karat: k }),
  /** Data with an optional Arabic variant (names). */
  text: (en: string, ar?: string | null): AuditParam => ({ en, ar: ar ?? null }),
  list: (items: AuditParam[]): AuditParam => ({ list: items }),
  /** A nested translatable phrase (its own key and params). */
  phrase: (key: string, params?: AuditParams): AuditParam => ({ key, params }),
};

export function formatAuditParamEn(p: AuditParam): string {
  if (typeof p === 'string') return p;
  if (typeof p === 'number') return p.toLocaleString('en-US');
  if ('money' in p) return `${Math.round(p.money).toLocaleString('en-US')} SDG`;
  if ('mg' in p) return `${(p.mg / 1000).toFixed(3)} g`;
  if ('enum' in p) return p.enum.replaceAll('_', ' ').toLowerCase();
  if ('karat' in p) return `${p.karat}K`;
  if ('list' in p) return p.list.map(formatAuditParamEn).join(', ');
  if ('key' in p) return auditDescriptionEn(p.key, p.params);
  return p.en;
}

/** Interpolate `{name}` placeholders with a formatter. */
export function interpolateParams(template: string, params: AuditParams | null | undefined, fmt: (p: AuditParam) => string): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? fmt(params[k]) : m));
}

export const auditDescriptionEn = (key: string, params?: AuditParams | null) => interpolateParams(key, params, formatAuditParamEn);
