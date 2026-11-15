-- LBL-2 (plan docs/plans/LBL-2.md §7, D-lbl2-1, owner answer Q6): the lines of the DRAFT openings that exist at the
-- update get their piece code and barcode now, so their labels can be printed before the seal. The backfill step,
-- separate from the additive migration 0042.
--   * Only lines of DRAFT openings that have no code yet (idempotent: a line with a code is skipped). The lines of a
--     sealed opening are not touched (their pieces carry the codes; the trigger forbids writing them anyway).
--   * The numbers come from the same counter as every piece (document_sequences 'ITEM', starting at 1001, as
--     core/numbering.ts nextItemCodes): one block, given in opening then line-number order. The counter moves past the
--     block, so a later supplier order or line takes the next number; a number is never handed out twice.
--   * Code `J-n`, barcode `628100` + n padded to 6 digits (never cut: a longer n keeps all its digits), as nextItemCode.
-- No row is deleted; no constraint or trigger is dropped.
WITH todo AS (
  SELECT ol.id, row_number() OVER (ORDER BY ol.opening_id, ol.line_no) AS rn
  FROM opening_lines ol
  JOIN openings o ON o.id = ol.opening_id
  WHERE o.status = 'DRAFT' AND ol.item_id IS NULL AND ol.reserved_code IS NULL
),
total AS (SELECT count(*)::int AS c FROM todo),
block AS (
  INSERT INTO document_sequences (scope, next)
  SELECT 'ITEM', 1001 + c FROM total WHERE c > 0
  ON CONFLICT (scope) DO UPDATE SET next = document_sequences.next + (EXCLUDED.next - 1001)
  RETURNING next - (SELECT c FROM total) AS first
),
numbered AS (
  SELECT todo.id, (block.first + todo.rn - 1)::bigint AS n FROM todo CROSS JOIN block
)
UPDATE opening_lines ol
SET reserved_code = 'J-' || numbered.n::text,
    reserved_barcode = '628100' || CASE WHEN length(numbered.n::text) >= 6 THEN numbered.n::text ELSE lpad(numbered.n::text, 6, '0') END
FROM numbered
WHERE ol.id = numbered.id;
