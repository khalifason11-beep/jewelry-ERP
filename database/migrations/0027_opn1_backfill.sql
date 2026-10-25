-- OPN-1 / CAT-1 backfill (plan docs/plans/OPN-1.md §2). Fills the columns 0026 added, once, from what each row already
-- points to. No row is created or deleted; no existing value is changed. Runs on a database that holds data.
--
-- 1. Every piece's type: the type of its product (every piece has a product before CAT-1).
UPDATE "jewelry_items" i SET "category_id" = p."category_id"
  FROM "products" p
  WHERE p."id" = i."product_id" AND i."category_id" IS NULL;--> statement-breakpoint
-- 2. Every sale line's names, as they are now (the English product name was already snapshotted in product_name):
--    the Arabic product name and both names of the type. From here on a rename never rewrites an invoice (D-cat0-3).
UPDATE "sale_items" si SET
    "product_name_ar" = p."name_ar",
    "category_name" = c."name",
    "category_name_ar" = c."name_ar"
  FROM "jewelry_items" i
  JOIN "products" p ON p."id" = i."product_id"
  JOIN "categories" c ON c."id" = p."category_id"
  WHERE i."id" = si."item_id" AND si."category_name_ar" IS NULL;--> statement-breakpoint
-- 3. Guard: nothing may be left unfilled. All pending migrations run in one transaction, so a failure here changes
--    nothing at all.
DO $$
DECLARE pieces integer; lines integer;
BEGIN
  SELECT count(*) INTO pieces FROM jewelry_items WHERE category_id IS NULL;
  SELECT count(*) INTO lines FROM sale_items WHERE category_name_ar IS NULL;
  IF pieces > 0 OR lines > 0 THEN
    RAISE EXCEPTION 'Migration 0027 (OPN-1) stopped: % piece(s) without a type and % sale line(s) without the type name after the backfill.', pieces, lines;
  END IF;
END $$;
