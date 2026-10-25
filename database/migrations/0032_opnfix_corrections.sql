CREATE TABLE "opening_piece_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"opening_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"kind" text NOT NULL,
	"condition_before" text NOT NULL,
	"condition_after" text NOT NULL,
	"karat_before" smallint NOT NULL,
	"karat_after" smallint NOT NULL,
	"gross_weight_mg_before" integer NOT NULL,
	"gross_weight_mg_after" integer NOT NULL,
	"net_weight_mg_before" integer NOT NULL,
	"net_weight_mg_after" integer NOT NULL,
	"reason" text NOT NULL,
	"corrected_by" integer NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "opening_piece_corrections_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "opening_piece_corrections_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "opening_piece_corrections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "opening_piece_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_piece_corrections_item_idx" ON "opening_piece_corrections" USING btree ("item_id","id");--> statement-breakpoint
CREATE INDEX "opening_piece_corrections_opening_idx" ON "opening_piece_corrections" USING btree ("opening_id","id");--> statement-breakpoint
-- ── OPN-FIX hand-written part (plan docs/plans/OPN-FIX.md §6, §10). Additive only: a new table, its checks and
-- triggers, a new permission and its grant. Nothing existing is changed.
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_kind" CHECK (kind IN ('CORRECT', 'VOID'));--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_condition_before" CHECK (condition_before IN ('NEW', 'USED'));--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_condition_after" CHECK (condition_after IN ('NEW', 'USED'));--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_karat_before_range" CHECK (karat_before BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_karat_after_range" CHECK (karat_after BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 200);--> statement-breakpoint
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_weights" CHECK (net_weight_mg_before > 0 AND net_weight_mg_before <= gross_weight_mg_before AND net_weight_mg_after > 0 AND net_weight_mg_after <= gross_weight_mg_after);--> statement-breakpoint
-- A void changes nothing but the status; a correction changes at least one value.
ALTER TABLE "opening_piece_corrections" ADD CONSTRAINT "ck_opening_piece_corrections_change" CHECK (
  (kind = 'VOID' AND condition_after = condition_before AND karat_after = karat_before AND gross_weight_mg_after = gross_weight_mg_before AND net_weight_mg_after = net_weight_mg_before)
  OR (kind = 'CORRECT' AND (condition_after <> condition_before OR karat_after <> karat_before OR gross_weight_mg_after <> gross_weight_mg_before OR net_weight_mg_after <> net_weight_mg_before))
);--> statement-breakpoint
-- The piece is a line of that opening, and the opening is sealed.
CREATE OR REPLACE FUNCTION jerp_opening_piece_correction_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM opening_lines l JOIN openings o ON o.id = l.opening_id
    WHERE l.item_id = NEW.item_id AND l.opening_id = NEW.opening_id AND o.status = 'SEALED'
  ) THEN
    RAISE EXCEPTION 'opening_piece_corrections: piece % is not a piece of sealed opening %', NEW.item_id, NEW.opening_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_piece_corrections_piece_check BEFORE INSERT ON "opening_piece_corrections"
  FOR EACH ROW EXECUTE FUNCTION jerp_opening_piece_correction_check();--> statement-breakpoint
-- Append-only: a wrong correction is corrected by a newer one, never edited.
CREATE TRIGGER opening_piece_corrections_append_only BEFORE UPDATE OR DELETE ON "opening_piece_corrections" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER opening_piece_corrections_no_truncate BEFORE TRUNCATE ON "opening_piece_corrections" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('opening_piece_corrections');--> statement-breakpoint
-- ── The permission, General Manager only (D-opnfix-2).
INSERT INTO "permissions" ("code", "description") VALUES
  ('opening.correct', 'Correct or void a piece of a sealed opening balance (reason, password and passkey)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'opening.correct' FROM "roles" r WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
