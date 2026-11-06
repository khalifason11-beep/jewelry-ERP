CREATE TABLE "sale_scrap_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"karat" smallint NOT NULL,
	"grains" integer NOT NULL,
	"weight_mg" integer NOT NULL,
	"rate_per_gram" bigint NOT NULL,
	"price" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "sale_scrap_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_scrap_lines_sale_line_uq" ON "sale_scrap_lines" USING btree ("sale_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_scrap_lines_sale_karat_uq" ON "sale_scrap_lines" USING btree ("sale_id","karat");--> statement-breakpoint
-- ── WSL-1 hand-written part (plan docs/plans/WSL-1.md, D-wsl1-1). One new append-only table, its checks, and the
-- pool's event-type CHECK widened with SCRAP_SALE (grains sold at the POS). No existing row is changed.
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_karat_range" CHECK (karat BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_line_no" CHECK (line_no >= 1);--> statement-breakpoint
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_grains_positive" CHECK (grains > 0);--> statement-breakpoint
-- 1 grain = 0.1 g = 100 mg (the owner's unit).
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_weight_is_grains" CHECK (weight_mg = grains * 100);--> statement-breakpoint
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_rate_positive" CHECK (rate_per_gram > 0);--> statement-breakpoint
ALTER TABLE "sale_scrap_lines" ADD CONSTRAINT "ck_sale_scrap_lines_price_positive" CHECK (price > 0);--> statement-breakpoint
-- Every grain line leaves the pool exactly once, at the sale: one SCRAP_SALE row of its weight, its karat and its sale's
-- branch (checked at commit, when both rows are written).
CREATE OR REPLACE FUNCTION jerp_sale_scrap_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM scrap_weight_entries e JOIN sales s ON s.id = NEW.sale_id
   WHERE e.ref_type = 'sale_scrap_line' AND e.ref_id = NEW.id AND e.event_type = 'SCRAP_SALE'
     AND e.weight_mg = -NEW.weight_mg AND e.karat = NEW.karat AND e.branch_id = s.branch_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'sale_scrap_lines: line % must leave the pool exactly once (found % matching SCRAP_SALE rows)', NEW.id, n;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_scrap_lines_pool AFTER INSERT ON "sale_scrap_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jerp_sale_scrap_line_check();--> statement-breakpoint
-- Append-only: a sale's lines never change; a void says it (the sale's status) and the pool gets a REVERSAL row.
CREATE TRIGGER sale_scrap_lines_append_only BEFORE UPDATE OR DELETE ON "sale_scrap_lines" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER sale_scrap_lines_no_truncate BEFORE TRUNCATE ON "sale_scrap_lines" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('sale_scrap_lines');--> statement-breakpoint
-- The pool's movement types (D-wsl1-1): grains sold at the POS (SCRAP_SALE).
-- allow-destructive: D-wsl1-1 replace the pool's event-type CHECK with the wider list (SCRAP_SALE); no row changes
ALTER TABLE "scrap_weight_entries" DROP CONSTRAINT "ck_scrap_weight_entries_event_type";--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "ck_scrap_weight_entries_event_type" CHECK (event_type IN ('SCRAP_PURCHASE', 'SUPPLIER_SETTLEMENT', 'REVERSAL', 'OPENING', 'OPENING_CORRECTION', 'SCRAP_SALE'));
