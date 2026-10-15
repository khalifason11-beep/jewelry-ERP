-- BE-7 (docs/plans/BE-7.md): the lines of a sale are read by sale (list pages, sale detail, void). Additive only.
-- Not CONCURRENTLY: migrations run in one transaction; sale_items writes wait while the index builds (about a second
-- on 100,000 lines).
CREATE INDEX "sale_items_sale_idx" ON "sale_items" USING btree ("sale_id");
