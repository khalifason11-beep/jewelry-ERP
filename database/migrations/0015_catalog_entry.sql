-- ── CAT-0: minimal entry of item types (categories), products and suppliers (docs/decisions.md D-cat0-*).
-- Additive only. Names are entered by people, so duplicates are prevented on a NORMALIZED Arabic name,
-- computed by the database itself (jerp_normalize_name) into generated columns with unique indexes:
-- the rule holds under concurrent requests and cannot drift from the application. The English name
-- becomes optional (the Arabic name is the reference); new flags record who created a row and whether
-- it is still offered (deactivated rows are kept, never deleted).

-- 1. The single normalization rule (mirrored in shared/src/names.ts; a property test proves they agree):
--    Unicode NFKC; remove zero-width characters (ZWSP, ZWNJ, ZWJ, LRM, RLM, BOM), tatweel and Arabic
--    diacritics; أ إ آ ٱ → ا and ى → ي (ة and ه stay distinct); Arabic-Indic and Eastern Arabic-Indic
--    digits → 0-9; Latin A-Z → a-z (not lower(), whose result depends on the collation); spaces
--    collapsed and trimmed. Characters are written as escapes so the file holds no invisible ones.
CREATE OR REPLACE FUNCTION jerp_normalize_name(s text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT btrim(regexp_replace(translate(
      regexp_replace(normalize(coalesce(s, ''), NFKC), U&'[\200B\200C\200D\200E\200F\FEFF\0640\064B-\065F\0670]', '', 'g'),
      U&'\0623\0625\0622\0671\0649\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      U&'\0627\0627\0627\0627\064A01234567890123456789abcdefghijklmnopqrstuvwxyz'), '[ \t\n\r\f\v]+', ' ', 'g'))
  $$;--> statement-breakpoint

-- 2. Refuse to continue on existing duplicates (they would break the unique indexes): list them all.
DO $$
DECLARE
  problems text := '';
  d text;
BEGIN
  SELECT string_agg(format('type "%s" (ids %s)', n, ids), '; ') INTO d FROM (
    SELECT jerp_normalize_name(name_ar) AS n, string_agg(id::text, ',' ORDER BY id) AS ids FROM categories GROUP BY 1 HAVING count(*) > 1) x;
  IF d IS NOT NULL THEN problems := problems || d || '; '; END IF;
  SELECT string_agg(format('product "%s" %sK type %s (ids %s)', n, karat, category_id, ids), '; ') INTO d FROM (
    SELECT jerp_normalize_name(name_ar) AS n, karat, category_id, string_agg(id::text, ',' ORDER BY id) AS ids FROM products GROUP BY 1, 2, 3 HAVING count(*) > 1) x;
  IF d IS NOT NULL THEN problems := problems || d || '; '; END IF;
  SELECT string_agg(format('supplier "%s" (ids %s)', n, ids), '; ') INTO d FROM (
    SELECT jerp_normalize_name(coalesce(name_ar, name)) AS n, string_agg(id::text, ',' ORDER BY id) AS ids FROM suppliers GROUP BY 1 HAVING count(*) > 1) x;
  IF d IS NOT NULL THEN problems := problems || d || '; '; END IF;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Migration 0015 (CAT-0) stopped: names that are the same after normalization: %Rename or merge these rows, then start again. Nothing was changed.', problems;
  END IF;
END $$;--> statement-breakpoint

-- 3. Item types (table categories).
ALTER TABLE "categories" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "name_ar_norm" text GENERATED ALWAYS AS (jerp_normalize_name(name_ar)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_ar_norm_uq" ON "categories" USING btree ("name_ar_norm");--> statement-breakpoint

-- 4. Products.
ALTER TABLE "products" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "name_ar_norm" text GENERATED ALWAYS AS (jerp_normalize_name(name_ar)) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "products_name_ar_norm_karat_category_uq" ON "products" USING btree ("name_ar_norm", "karat", "category_id");--> statement-breakpoint

-- 5. Suppliers (rows from before CAT-0 may have no Arabic name: the English one is used for the check).
ALTER TABLE "suppliers" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "created_by" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "name_norm" text GENERATED ALWAYS AS (jerp_normalize_name(coalesce(name_ar, name))) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_norm_uq" ON "suppliers" USING btree ("name_norm");--> statement-breakpoint
-- At least one name, and never an empty one (the application requires the Arabic name for new rows).
ALTER TABLE "suppliers" ADD CONSTRAINT "ck_suppliers_has_name" CHECK (coalesce(nullif(btrim(name_ar), ''), nullif(btrim(name), '')) IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "suppliers" VALIDATE CONSTRAINT "ck_suppliers_has_name";--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_name_ar_not_blank" CHECK (btrim(name_ar) <> '') NOT VALID;--> statement-breakpoint
ALTER TABLE "categories" VALIDATE CONSTRAINT "ck_categories_name_ar_not_blank";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_name_ar_not_blank" CHECK (btrim(name_ar) <> '') NOT VALID;--> statement-breakpoint
ALTER TABLE "products" VALIDATE CONSTRAINT "ck_products_name_ar_not_blank";
