CREATE TABLE "opening_scrap_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"opening_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"karat" smallint NOT NULL,
	"weight_mg_change" integer NOT NULL,
	"reason" text NOT NULL,
	"corrected_by" integer NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_scrap_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"opening_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"karat" smallint NOT NULL,
	"weight_mg" integer NOT NULL,
	"note" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "opening_scrap_corrections_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "opening_scrap_corrections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "opening_scrap_corrections_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "opening_scrap_lines_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "opening_scrap_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "opening_scrap_lines_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_scrap_corrections_opening_idx" ON "opening_scrap_corrections" USING btree ("opening_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_scrap_lines_no_uq" ON "opening_scrap_lines" USING btree ("opening_id","line_no");--> statement-breakpoint
-- ── OPN-3 hand-written part (plan docs/plans/OPN-3.md §2). Two new tables, their checks and triggers, and the pool's
-- event-type CHECK widened with OPENING and OPENING_CORRECTION. No existing row is changed.
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "ck_opening_scrap_lines_karat_range" CHECK (karat BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "ck_opening_scrap_lines_weight_positive" CHECK (weight_mg > 0);--> statement-breakpoint
ALTER TABLE "opening_scrap_lines" ADD CONSTRAINT "ck_opening_scrap_lines_note" CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "ck_opening_scrap_corrections_karat_range" CHECK (karat BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "ck_opening_scrap_corrections_weight_nonzero" CHECK (weight_mg_change <> 0);--> statement-breakpoint
ALTER TABLE "opening_scrap_corrections" ADD CONSTRAINT "ck_opening_scrap_corrections_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 200);--> statement-breakpoint
-- The broken scrap of a sealed opening never changes (as its pieces' lines, migration 0026).
CREATE OR REPLACE FUNCTION jerp_opening_scrap_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM openings WHERE id = COALESCE(NEW.opening_id, OLD.opening_id);
  IF st = 'SEALED' THEN
    RAISE EXCEPTION 'opening_scrap_lines: opening % is sealed', COALESCE(NEW.opening_id, OLD.opening_id);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.opening_id <> OLD.opening_id OR NEW.line_no <> OLD.line_no OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'opening_scrap_lines: only the karat, the weight and the note of a draft line may change';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_scrap_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "opening_scrap_lines" FOR EACH ROW EXECUTE FUNCTION jerp_opening_scrap_line_check();--> statement-breakpoint
CREATE TRIGGER opening_scrap_lines_no_truncate BEFORE TRUNCATE ON "opening_scrap_lines" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- A correction is of a sealed opening, in that opening's branch.
CREATE OR REPLACE FUNCTION jerp_opening_scrap_correction_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM openings o WHERE o.id = NEW.opening_id AND o.status = 'SEALED' AND o.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'opening_scrap_corrections: opening % is not a sealed opening of branch %', NEW.opening_id, NEW.branch_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_scrap_corrections_check BEFORE INSERT ON "opening_scrap_corrections" FOR EACH ROW EXECUTE FUNCTION jerp_opening_scrap_correction_check();--> statement-breakpoint
-- Append-only: a wrong correction is corrected by a newer one, never edited.
CREATE TRIGGER opening_scrap_corrections_append_only BEFORE UPDATE OR DELETE ON "opening_scrap_corrections" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER opening_scrap_corrections_no_truncate BEFORE TRUNCATE ON "opening_scrap_corrections" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('opening_scrap_corrections');--> statement-breakpoint
-- The pool's movement types (D-opn3-1): the seal (OPENING) and a correction after it (OPENING_CORRECTION).
-- allow-destructive: D-opn3-1 replace the pool's event-type CHECK with the wider list (OPENING, OPENING_CORRECTION); no row changes
ALTER TABLE "scrap_weight_entries" DROP CONSTRAINT "ck_scrap_weight_entries_event_type";--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "ck_scrap_weight_entries_event_type" CHECK (event_type IN ('SCRAP_PURCHASE', 'SUPPLIER_SETTLEMENT', 'REVERSAL', 'OPENING', 'OPENING_CORRECTION'));
