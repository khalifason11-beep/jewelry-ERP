// Cost, acquisition cost and profit are visible to the General Manager only (decision Q15).
// Services already omit these fields for callers without `profit.view`; this response filter is
// the second, central line of defence. Which fields are COST is decided by ONE registry,
// shared/src/field-classification.ts (D-2a-7), not by a list kept here:
//   * every COST field is removed, at any depth;
//   * report column descriptors describing a COST field are removed;
//   * audit entries (from any endpoint) get COST-named parameters replaced by { hidden: true } and
//     their English description re-rendered, so "… cost 45,000,000" never reaches a branch manager.

import type { NextFunction, Request, Response } from 'express';
import { COST_RESPONSE_FIELDS, auditDescriptionEn, scanResponse, type AuditParams, type FieldFinding } from '@jerp/shared';

/** Kept for callers/tests that need the set; it IS the registry's COST set. */
export const COST_FIELDS = COST_RESPONSE_FIELDS;

function isAuditEntry(v: Record<string, unknown>): v is Record<string, unknown> & { descriptionKey: string; descriptionParams: AuditParams | null } {
  return typeof v.descriptionKey === 'string' && 'descriptionParams' in v;
}

/** Audit entry with cost-named parameters hidden and its English description re-rendered. */
function redactAuditEntry(v: Record<string, unknown> & { descriptionKey: string; descriptionParams: AuditParams | null }) {
  const params = v.descriptionParams;
  if (!params || !Object.keys(params).some((k) => COST_FIELDS.has(k))) return v;
  const hidden: AuditParams = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, COST_FIELDS.has(k) ? { hidden: true as const } : p]));
  return { ...v, descriptionParams: hidden, ...('description' in v ? { description: auditDescriptionEn(v.descriptionKey, hidden) } : {}) };
}

/** Deep copy without cost fields (see header). */
export function stripCostFields(value: unknown, depth = 0): unknown {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { key?: unknown }).key === 'string' && COST_FIELDS.has((v as { key: string }).key)))
      .map((v) => stripCostFields(v, depth + 1));
  }
  let obj = value as Record<string, unknown>;
  if (isAuditEntry(obj)) obj = redactAuditEntry(obj);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (COST_FIELDS.has(k)) continue;
    // Audit parameters were already handled above; keep the { hidden: true } markers.
    out[k] = k === 'descriptionParams' ? v : stripCostFields(v, depth + 1);
  }
  return out;
}

// ── Test-mode check: every field name the API sends must be classified (tests fail otherwise).
const unclassified = new Map<string, string>();
const recordUnclassified = process.env.VITEST ? (route: string, body: unknown) => {
  for (const f of scanResponse(body)) if (f.kind === 'UNCLASSIFIED' && !unclassified.has(f.name)) unclassified.set(f.name, `${route} ${f.path}`);
} : null;
/** Field names seen in responses during this test run that the registry does not classify. */
export function unclassifiedResponseFields(): FieldFinding[] {
  return [...unclassified].map(([name, where]) => ({ name, path: where, kind: 'UNCLASSIFIED' as const }));
}

/** Wrap res.json for callers without `profit.view`. */
export function costRedaction(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    const isError = !!body && typeof body === 'object' && 'error' in (body as object);
    if (!isError) recordUnclassified?.(`${req.method} ${req.baseUrl}${req.path}`, body);
    const actor = req.actor;
    if (!actor || actor.permissions.has('profit.view')) return json(body);
    // Error bodies carry no business data.
    if (isError) return json(body);
    return json(stripCostFields(JSON.parse(JSON.stringify(body))));
  };
  next();
}
