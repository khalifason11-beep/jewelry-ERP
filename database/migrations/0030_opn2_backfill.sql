-- OPN-2 (plan docs/plans/OPN-2.md §2, D-opn2-3): which rate prices each existing piece, as today (no price moves):
-- a sellable scrap piece the USED rate, every other piece (supplier, and opening pieces sealed before OPN-2) the NEW rate.
-- A DRAFT opening that already has lines stops the upgrade: its lines have no condition, and guessing "new" for a
-- person's unfinished count is the error OPN-2 removes. Finish (seal) or empty the draft, then upgrade.
DO $$
DECLARE drafts text;
BEGIN
  SELECT string_agg(b.code || ' (' || n.c || ' line(s))', ', ' ORDER BY b.code) INTO drafts
  FROM openings o JOIN branches b ON b.id = o.branch_id
  JOIN (SELECT opening_id, count(*) AS c FROM opening_lines GROUP BY opening_id) n ON n.opening_id = o.id
  WHERE o.status = 'DRAFT';
  IF drafts IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 0030 (OPN-2) stopped: the opening balance draft of % has lines without a condition (new or used). Seal or empty the draft before upgrading; nothing was changed', drafts;
  END IF;
END $$;--> statement-breakpoint
UPDATE jewelry_items SET rate_kind = CASE WHEN origin = 'SCRAP' THEN 'USED' ELSE 'NEW' END WHERE rate_kind IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jewelry_items WHERE rate_kind IS NULL) THEN
    RAISE EXCEPTION 'Migration 0030 (OPN-2) stopped: % piece(s) have no rate kind', (SELECT count(*) FROM jewelry_items WHERE rate_kind IS NULL);
  END IF;
END $$;
