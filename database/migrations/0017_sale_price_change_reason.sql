-- ── SEC-2 (docs/plans/POS-FIXES.md §5, docs/decisions.md D-sec2-2): the reason given at the counter when a line's
-- final price differs from its list price. Stored on the sale (managers see it on the sale detail) and in the
-- audit log (SALE_PRICE_CHANGED); the printed invoice reads a fixed allow-list and never this column.
-- Additive only: a nullable column (old sales have none) and a CHECK on the new column, valid for every row
-- because every existing row is NULL.
ALTER TABLE "sales" ADD COLUMN "price_change_reason" text;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_price_change_reason" CHECK (price_change_reason IS NULL OR length(btrim(price_change_reason)) BETWEEN 3 AND 200);
