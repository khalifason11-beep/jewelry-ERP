CREATE TABLE "opening_label_prints" (
	"id" serial PRIMARY KEY NOT NULL,
	"opening_id" integer NOT NULL,
	"opening_line_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"code" text NOT NULL,
	"barcode" text NOT NULL,
	"branch_id" integer NOT NULL,
	"copies" smallint NOT NULL,
	"kind" text NOT NULL,
	"batch_id" text NOT NULL,
	"printed_by" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_prints" ADD COLUMN "draft_print_id" integer;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD COLUMN "reserved_code" text;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD COLUMN "reserved_barcode" text;--> statement-breakpoint
ALTER TABLE "opening_label_prints" ADD CONSTRAINT "opening_label_prints_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_label_prints" ADD CONSTRAINT "opening_label_prints_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_label_prints" ADD CONSTRAINT "opening_label_prints_printed_by_users_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opening_label_prints_opening_idx" ON "opening_label_prints" USING btree ("opening_id","id");--> statement-breakpoint
CREATE INDEX "opening_label_prints_line_idx" ON "opening_label_prints" USING btree ("opening_line_id","id");--> statement-breakpoint
CREATE INDEX "opening_label_prints_code_idx" ON "opening_label_prints" USING btree ("code","id");--> statement-breakpoint
CREATE INDEX "opening_label_prints_branch_at_idx" ON "opening_label_prints" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_label_prints_first_uq" ON "opening_label_prints" USING btree ("code") WHERE kind = 'FIRST';--> statement-breakpoint
CREATE UNIQUE INDEX "label_prints_draft_print_uq" ON "label_prints" USING btree ("draft_print_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_lines_reserved_code_uq" ON "opening_lines" USING btree ("reserved_code");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_lines_reserved_barcode_uq" ON "opening_lines" USING btree ("reserved_barcode");--> statement-breakpoint
-- ── LBL-2 hand-written part (plan docs/plans/LBL-2.md, D-lbl2-1, D-lbl2-3): an opening line's piece code is given when
-- the line is added, so its label can be printed before the seal. Additive: new nullable columns, a new table, new
-- indexes and checks that hold on every existing row (all NULL); no existing row changes. Codes for the lines of the
-- draft openings that exist today are given by the next migration (0043), the rule "every draft line has a code" is
-- added by 0044.
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_reserved_pair" CHECK ((reserved_code IS NULL) = (reserved_barcode IS NULL));--> statement-breakpoint
ALTER TABLE "opening_label_prints" ADD CONSTRAINT "ck_opening_label_prints_kind" CHECK (kind IN ('FIRST', 'REPRINT'));--> statement-breakpoint
ALTER TABLE "opening_label_prints" ADD CONSTRAINT "ck_opening_label_prints_copies" CHECK (copies BETWEEN 1 AND 20);--> statement-breakpoint
-- The lines: as before (0029), and a reserved code once set never changes (its label may be printed already).
CREATE OR REPLACE FUNCTION jerp_opening_line_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM openings WHERE id = COALESCE(NEW.opening_id, OLD.opening_id);
  IF st = 'SEALED' THEN
    RAISE EXCEPTION 'opening_lines: opening % is sealed', COALESCE(NEW.opening_id, OLD.opening_id);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.condition IS NULL THEN
    RAISE EXCEPTION 'opening_lines: line % of opening % has no condition (new or used)', NEW.line_no, NEW.opening_id;
  END IF;
  IF NEW.import_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opening_imports oi WHERE oi.id = NEW.import_id AND oi.opening_id = NEW.opening_id) THEN
    RAISE EXCEPTION 'opening_lines: import % is not an import of opening %', NEW.import_id, NEW.opening_id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.reserved_code IS NOT NULL AND (NEW.reserved_code IS DISTINCT FROM OLD.reserved_code OR NEW.reserved_barcode IS DISTINCT FROM OLD.reserved_barcode) THEN
    RAISE EXCEPTION 'opening_lines: line % of opening % keeps its code %', OLD.line_no, OLD.opening_id, OLD.reserved_code;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
-- A print before the seal: on a line of that DRAFT opening, with the line's reserved code and barcode, in the opening's
-- branch; FIRST only for a code never printed before the seal, REPRINT only after one.
CREATE OR REPLACE FUNCTION jerp_opening_label_print_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM openings o WHERE o.id = NEW.opening_id AND o.status = 'DRAFT' AND o.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'opening_label_prints: opening % is not a draft of branch %', NEW.opening_id, NEW.branch_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM opening_lines ol WHERE ol.id = NEW.opening_line_id AND ol.opening_id = NEW.opening_id AND ol.line_no = NEW.line_no AND ol.reserved_code = NEW.code AND ol.reserved_barcode = NEW.barcode) THEN
    RAISE EXCEPTION 'opening_label_prints: line % of opening % does not hold code %', NEW.opening_line_id, NEW.opening_id, NEW.code;
  END IF;
  SELECT count(*) INTO before_n FROM opening_label_prints WHERE code = NEW.code;
  IF (NEW.kind = 'FIRST') <> (before_n = 0) THEN
    RAISE EXCEPTION 'opening_label_prints: code % has % earlier print(s); this one cannot be %', NEW.code, before_n, NEW.kind;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_label_prints_check BEFORE INSERT ON "opening_label_prints" FOR EACH ROW EXECUTE FUNCTION jerp_opening_label_print_check();--> statement-breakpoint
-- Append-only: a label printed is never unrecorded, edited or deleted.
CREATE TRIGGER opening_label_prints_append_only BEFORE UPDATE OR DELETE ON "opening_label_prints" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER opening_label_prints_no_truncate BEFORE TRUNCATE ON "opening_label_prints" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('opening_label_prints');--> statement-breakpoint
-- The piece prints: as before (0041), and a row copied at the seal from a print before it names a print of the
-- piece's own code, in the same branch, with the same kind and copies.
CREATE OR REPLACE FUNCTION jerp_label_print_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jewelry_items i WHERE i.id = NEW.item_id AND i.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'label_prints: piece % is not in branch %', NEW.item_id, NEW.branch_id;
  END IF;
  SELECT count(*) INTO before_n FROM label_prints WHERE item_id = NEW.item_id;
  IF (NEW.kind = 'FIRST') <> (before_n = 0) THEN
    RAISE EXCEPTION 'label_prints: piece % has % earlier print(s); this one cannot be %', NEW.item_id, before_n, NEW.kind;
  END IF;
  IF NEW.draft_print_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM opening_label_prints d JOIN jewelry_items i ON i.id = NEW.item_id
    WHERE d.id = NEW.draft_print_id AND d.code = i.code AND d.branch_id = NEW.branch_id AND d.kind = NEW.kind AND d.copies = NEW.copies
  ) THEN
    RAISE EXCEPTION 'label_prints: draft print % is not a print of piece %', NEW.draft_print_id, NEW.item_id;
  END IF;
  RETURN NEW;
END $$;
