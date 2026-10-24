CREATE TABLE "purchase_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"purchase_item_id" integer,
	"field" text NOT NULL,
	"value_before" text,
	"value_after" text NOT NULL,
	"reason" text NOT NULL,
	"confirmed_duplicate" boolean DEFAULT false NOT NULL,
	"corrected_by" integer NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrap_purchase_voids" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"reason" text NOT NULL,
	"voided_by" integer NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrap_purchase_voids_purchase_id_unique" UNIQUE("purchase_id")
);
--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "purchase_corrections_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "purchase_corrections_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "purchase_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrap_purchase_voids" ADD CONSTRAINT "scrap_purchase_voids_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_corrections_purchase_idx" ON "purchase_corrections" USING btree ("purchase_id","id");--> statement-breakpoint
CREATE INDEX "purchase_corrections_item_idx" ON "purchase_corrections" USING btree ("purchase_item_id","id");--> statement-breakpoint
-- ── MIS-1 hand-written part (plan docs/plans/MIS-1.md §5). Additive, except the three status checks below (D-mis1-1).
ALTER TABLE "scrap_purchase_voids" ADD CONSTRAINT "ck_scrap_purchase_voids_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 200);--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "ck_purchase_corrections_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 200);--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "ck_purchase_corrections_field" CHECK (field IN ('MAKING_COST', 'MAKING_CHARGE_REFERENCE'));--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "ck_purchase_corrections_item" CHECK ((field = 'MAKING_COST') = (purchase_item_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "ck_purchase_corrections_making_cost" CHECK (field <> 'MAKING_COST' OR value_after ~ '^(0|[1-9][0-9]{0,14})$');--> statement-breakpoint
ALTER TABLE "purchase_corrections" ADD CONSTRAINT "ck_purchase_corrections_reference" CHECK (field <> 'MAKING_CHARGE_REFERENCE' OR length(btrim(value_after)) BETWEEN 4 AND 40);--> statement-breakpoint
-- A void names an existing scrap purchase (no foreign key: see the schema comment on scrap_purchase_voids.purchase_id).
CREATE OR REPLACE FUNCTION jerp_scrap_purchase_void_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scrap_purchases sp WHERE sp.id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'scrap_purchase_voids: scrap purchase % does not exist', NEW.purchase_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER scrap_purchase_voids_purchase_check BEFORE INSERT ON "scrap_purchase_voids"
  FOR EACH ROW EXECUTE FUNCTION jerp_scrap_purchase_void_check();--> statement-breakpoint
-- A piece's correction names a line of the same order.
CREATE OR REPLACE FUNCTION jerp_purchase_correction_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purchase_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_items pi WHERE pi.id = NEW.purchase_item_id AND pi.purchase_id = NEW.purchase_id
  ) THEN
    RAISE EXCEPTION 'purchase_corrections: line % is not on purchase %', NEW.purchase_item_id, NEW.purchase_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER purchase_corrections_line_check BEFORE INSERT ON "purchase_corrections"
  FOR EACH ROW EXECUTE FUNCTION jerp_purchase_correction_check();--> statement-breakpoint
-- Both tables are append-only (a wrong void or correction is never edited; a correction is corrected by a newer one).
CREATE TRIGGER scrap_purchase_voids_append_only BEFORE UPDATE OR DELETE ON "scrap_purchase_voids" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_purchase_voids_no_truncate BEFORE TRUNCATE ON "scrap_purchase_voids" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('scrap_purchase_voids');--> statement-breakpoint
CREATE TRIGGER purchase_corrections_append_only BEFORE UPDATE OR DELETE ON "purchase_corrections" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER purchase_corrections_no_truncate BEFORE TRUNCATE ON "purchase_corrections" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('purchase_corrections');--> statement-breakpoint
-- ── The VOIDED piece status (the piece of a voided scrap purchase). A pure widening: every existing row stays valid.
-- allow-destructive: D-mis1-1 owner approval 2026-10-19: replace the piece status check to add VOIDED
ALTER TABLE "jewelry_items" DROP CONSTRAINT "ck_jewelry_items_status";--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_status" CHECK (status IN ('AVAILABLE', 'SOLD', 'TRANSFERRED', 'DAMAGED', 'RETURNED', 'VOIDED'));--> statement-breakpoint
-- allow-destructive: D-mis1-1 owner approval 2026-10-19: replace the history from-status check to add VOIDED
ALTER TABLE "item_status_history" DROP CONSTRAINT "ck_item_status_history_from_status";--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "ck_item_status_history_from_status" CHECK (from_status IS NULL OR from_status IN ('AVAILABLE', 'SOLD', 'TRANSFERRED', 'DAMAGED', 'RETURNED', 'VOIDED', 'PURCHASED', 'RECEIVED'));--> statement-breakpoint
-- allow-destructive: D-mis1-1 owner approval 2026-10-19: replace the history to-status check to add VOIDED
ALTER TABLE "item_status_history" DROP CONSTRAINT "ck_item_status_history_to_status";--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "ck_item_status_history_to_status" CHECK (to_status IN ('AVAILABLE', 'SOLD', 'TRANSFERRED', 'DAMAGED', 'RETURNED', 'VOIDED', 'PURCHASED', 'RECEIVED'));--> statement-breakpoint
-- ── The two permissions, General Manager only (MIS-1 §2).
INSERT INTO "permissions" ("code", "description") VALUES
  ('scrap.void', 'Void a scrap purchase made by mistake (reason and password; money, piece or pool weight reversed)'),
  ('purchases.correct', 'Correct a supplier order''s piece making cost or transfer reference (reason and password)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('scrap.void'), ('purchases.correct')) AS p(code)
  WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
