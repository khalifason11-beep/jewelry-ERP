// Renders audit descriptions and ledger notes in the active language.
// Audit rows carry a translation key + typed params (see @jerp/shared `ap`); money and weights are
// formatted here, names use their Arabic variant when available, enum codes are translated.

import { interpolateParams, type AuditParam, type AuditParams } from '@jerp/shared';
import { getLang, translate } from './i18n';
import { humanize, karatLabel, money } from './format';

const listSep = () => (getLang() === 'ar' ? '، ' : ', ');

export function formatAuditParam(p: AuditParam): string {
  if (typeof p === 'string') return translate(p);
  if (typeof p === 'number') return p.toLocaleString('en-US');
  if ('money' in p) return money(p.money);
  if ('mg' in p) return `${(p.mg / 1000).toFixed(3)} ${getLang() === 'ar' ? 'جم' : 'g'}`;
  if ('enum' in p) return humanize(p.enum);
  if ('karat' in p) return karatLabel(p.karat);
  if ('list' in p) return p.list.map(formatAuditParam).join(listSep());
  if ('key' in p) return renderKey(p.key, p.params);
  return getLang() === 'ar' ? p.ar || p.en : p.en;
}

function renderKey(key: string, params?: AuditParams | null) {
  return interpolateParams(translate(key), params, formatAuditParam);
}

/** Localized audit description; falls back to the stored English text for rows without a key. */
export function auditText(row: { description?: string | null; descriptionKey?: string | null; descriptionParams?: AuditParams | null }): string {
  if (row.descriptionKey) return renderKey(row.descriptionKey, row.descriptionParams);
  return row.description ?? '';
}

// Item status/movement notes written by the backend. Free-text reasons pass through unchanged.
const NOTE_PATTERNS: [RegExp, string, string[]][] = [
  [/^Sale cancelled: ([\s\S]*)$/, 'Sale cancelled: {reason}', ['reason']],
  [/^Returned to supplier: ([\s\S]*)$/, 'Returned to supplier: {reason}', ['reason']],
  [/^In transit to (.+)$/, 'In transit to {branch}', ['branch']],
  [/^Selected by Hasad customer \((.+)\)$/, 'Selected by Hasad customer ({id})', ['id']],
  [/^Delivered to Hasad customer \((.+)\)$/, 'Delivered to Hasad customer ({id})', ['id']],
];

export function noteText(note: string | null | undefined): string {
  if (!note) return '';
  for (const [re, key, names] of NOTE_PATTERNS) {
    const m = note.match(re);
    if (m) return renderKey(key, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  return translate(note);
}
