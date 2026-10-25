-- OPN-2 (plan docs/plans/OPN-2.md §2): the condition of opening pieces (additive; 0030 fills, 0031 tightens).
--   * jewelry_items.rate_kind: which selling rate prices the piece (NEW | USED), set when the piece is created;
--   * opening_lines.condition: NEW | USED, required on every new line (the trigger below); NULL only on the lines of
--     an opening sealed before OPN-2, which are never edited.
ALTER TABLE "jewelry_items" ADD COLUMN "rate_kind" text;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD COLUMN "condition" text;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_rate_kind" CHECK (rate_kind IS NULL OR rate_kind IN ('NEW', 'USED'));--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_condition" CHECK (condition IS NULL OR condition IN ('NEW', 'USED'));--> statement-breakpoint
-- The line guard of 0026, plus: a line written from now on states its condition (no default, D-opn2-2).
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
  RETURN NEW;
END $$;
