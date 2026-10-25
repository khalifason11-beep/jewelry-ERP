CREATE TABLE "opening_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"opening_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"row_count" integer NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"opening_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"category_id" integer NOT NULL,
	"description" text,
	"karat" smallint NOT NULL,
	"gross_weight_mg" integer NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"source" text NOT NULL,
	"import_id" integer,
	"item_id" integer,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_lines_item_id_unique" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "openings" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_by" integer,
	"sealed_at" timestamp with time zone,
	"session_id" text,
	CONSTRAINT "openings_branch_id_unique" UNIQUE("branch_id")
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "cost_value" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ALTER COLUMN "acquisition_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "unit_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "acquisition_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "profit" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "product_name_ar" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "category_name_ar" text;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "unknown_cost_lines" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "opening_imports" ADD CONSTRAINT "opening_imports_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_imports" ADD CONSTRAINT "opening_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "opening_lines_opening_id_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "opening_lines_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "opening_lines_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "opening_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openings" ADD CONSTRAINT "openings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openings" ADD CONSTRAINT "openings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openings" ADD CONSTRAINT "openings_sealed_by_users_id_fk" FOREIGN KEY ("sealed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_imports_file_uq" ON "opening_imports" USING btree ("opening_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_lines_no_uq" ON "opening_lines" USING btree ("opening_id","line_no");--> statement-breakpoint
CREATE INDEX "opening_lines_karat_idx" ON "opening_lines" USING btree ("opening_id","karat");--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "jewelry_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_category_idx" ON "jewelry_items" USING btree ("category_id");--> statement-breakpoint
-- ── OPN-1 hand-written part (plan docs/plans/OPN-1.md §2). Additive only: new columns, tables, checks, triggers. The
-- DROP NOT NULLs above loosen nothing that exists today: every row still holds its product and its cost; 0028 tightens
-- again (a type on every piece; an unknown cost only on an opening piece).
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_description" CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_unknown_cost_lines_nonneg" CHECK (unknown_cost_lines >= 0);--> statement-breakpoint
ALTER TABLE "openings" ADD CONSTRAINT "ck_openings_status" CHECK (status IN ('DRAFT', 'SEALED'));--> statement-breakpoint
ALTER TABLE "openings" ADD CONSTRAINT "ck_openings_sealed" CHECK ((status = 'SEALED') = (sealed_at IS NOT NULL AND sealed_by IS NOT NULL));--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_source" CHECK (source IN ('KEYBOARD', 'IMPORT'));--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_karat_range" CHECK (karat BETWEEN 1 AND 24);--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_weights" CHECK (net_weight_mg > 0 AND net_weight_mg <= gross_weight_mg);--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_description" CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_import" CHECK ((source = 'IMPORT') = (import_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "opening_imports" ADD CONSTRAINT "ck_opening_imports_row_count" CHECK (row_count > 0);--> statement-breakpoint
ALTER TABLE "opening_imports" ADD CONSTRAINT "ck_opening_imports_sha256" CHECK (sha256 ~ '^[0-9a-f]{64}$');--> statement-breakpoint
-- An opening is created as a DRAFT, sealed once, and never changed or deleted afterwards.
CREATE OR REPLACE FUNCTION jerp_opening_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'openings: an opening is never deleted';
  END IF;
  IF OLD.status = 'SEALED' THEN
    RAISE EXCEPTION 'openings: opening % is sealed', OLD.id;
  END IF;
  IF NEW.branch_id <> OLD.branch_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'openings: only the seal may change an opening';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER openings_guard BEFORE UPDATE OR DELETE ON "openings" FOR EACH ROW EXECUTE FUNCTION jerp_opening_check();--> statement-breakpoint
CREATE TRIGGER openings_no_truncate BEFORE TRUNCATE ON "openings" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- The lines of a sealed opening never change; an imported line names an import of the same opening (no foreign key
-- to the append-only opening_imports, D-mis1-3).
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
  IF NEW.import_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM opening_imports oi WHERE oi.id = NEW.import_id AND oi.opening_id = NEW.opening_id) THEN
    RAISE EXCEPTION 'opening_lines: import % is not an import of opening %', NEW.import_id, NEW.opening_id;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER opening_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "opening_lines" FOR EACH ROW EXECUTE FUNCTION jerp_opening_line_check();--> statement-breakpoint
CREATE TRIGGER opening_lines_no_truncate BEFORE TRUNCATE ON "opening_lines" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- The imports are append-only (the record of which file was imported, by whom, when).
CREATE TRIGGER opening_imports_append_only BEFORE UPDATE OR DELETE ON "opening_imports" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER opening_imports_no_truncate BEFORE TRUNCATE ON "opening_imports" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('opening_imports');--> statement-breakpoint
-- ── The permission, General Manager only (OPN-1 §4).
INSERT INTO "permissions" ("code", "description") VALUES
  ('opening.manage', 'Enter, import, review and seal the opening balance of a branch (once per branch)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'opening.manage' FROM "roles" r WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
