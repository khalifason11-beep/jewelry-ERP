import { sql } from 'drizzle-orm';
import type { Executor } from '@jerp/database';
import { rows } from './sql';

export type DocType = 'INV' | 'PO' | 'EXP' | 'TRF' | 'HR' | 'SET';

/** Atomically allocate the next value of a named sequence (starts at `start`). */
export async function nextSeq(exec: Executor, scope: string, start = 1): Promise<number> {
  const res = await exec.execute(sql`
    INSERT INTO document_sequences (scope, next) VALUES (${scope}, ${start + 1})
    ON CONFLICT (scope) DO UPDATE SET next = document_sequences.next + 1
    RETURNING next - 1 AS n`);
  return Number(rows<{ n: number }>(res)[0].n);
}

/** Next document number, e.g. KRT-INV-000124. */
export async function nextNumber(exec: Executor, prefix: string, type: DocType): Promise<string> {
  const n = await nextSeq(exec, `${prefix}-${type}`);
  return `${prefix}-${type}-${String(n).padStart(6, '0')}`;
}

/** Next jewelry item code and its EAN-13-style barcode (628 = demo GS1 prefix). */
export async function nextItemCode(exec: Executor): Promise<{ code: string; barcode: string }> {
  const n = await nextSeq(exec, 'ITEM', 1001);
  return { code: `J-${n}`, barcode: `628100${String(n).padStart(6, '0')}` };
}
