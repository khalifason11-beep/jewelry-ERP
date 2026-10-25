-- OPN-2 c2 (plan docs/plans/OPN-2.md §2): the tightening after 0029 (additive) and 0030 (backfill).
--   * every piece says which rate prices it (0030 filled it; every entry since writes it). No default;
--   * only an opening piece may be either: sellable scrap is USED, a supplier piece NEW.
-- Nothing is removed or rewritten. A row that breaks either rule stops the migration with its count.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jewelry_items WHERE rate_kind IS NULL) THEN
    RAISE EXCEPTION 'Migration 0031 (OPN-2) stopped: % piece(s) have no rate kind', (SELECT count(*) FROM jewelry_items WHERE rate_kind IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM jewelry_items WHERE (origin = 'SCRAP' AND rate_kind <> 'USED') OR (origin = 'SUPPLIER_NEW' AND rate_kind <> 'NEW')) THEN
    RAISE EXCEPTION 'Migration 0031 (OPN-2) stopped: % scrap or supplier piece(s) have the other rate kind', (SELECT count(*) FROM jewelry_items WHERE (origin = 'SCRAP' AND rate_kind <> 'USED') OR (origin = 'SUPPLIER_NEW' AND rate_kind <> 'NEW'));
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "jewelry_items" ALTER COLUMN "rate_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_rate_kind_origin" CHECK ((origin <> 'SCRAP' OR rate_kind = 'USED') AND (origin <> 'SUPPLIER_NEW' OR rate_kind = 'NEW'));
