-- OPN-1 c5 (plan docs/plans/OPN-1.md §2): the tightening after 0026 (additive) and 0027 (backfill).
--   * every piece has a type (0027 filled it from the product; every entry since writes it);
--   * only an opening piece may have an unknown cost (D-dec1-3: NULL, never 0).
-- Nothing is removed or rewritten. A row that breaks either rule stops the migration with a clear message.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jewelry_items WHERE category_id IS NULL) THEN
    RAISE EXCEPTION 'Migration 0028 (OPN-1) stopped: % piece(s) have no type', (SELECT count(*) FROM jewelry_items WHERE category_id IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM jewelry_items WHERE acquisition_cost IS NULL AND origin <> 'OPENING') THEN
    RAISE EXCEPTION 'Migration 0028 (OPN-1) stopped: % piece(s) not from an opening balance have no cost', (SELECT count(*) FROM jewelry_items WHERE acquisition_cost IS NULL AND origin <> 'OPENING');
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "jewelry_items" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_cost_known" CHECK (acquisition_cost IS NOT NULL OR origin = 'OPENING');
