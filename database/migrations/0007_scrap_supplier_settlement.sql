-- Phase 4: counter scrap purchases, the broken-scrap weight pool, gold-for-gold supplier settlement,
-- and the HASAD payment method (docs/decisions.md D-4-*). Forward-only; nothing is backfilled with
-- invented data: the new tables start empty, and purchase orders recorded before this phase keep a NULL
-- gold debt (they cannot be settled with scrap).
CREATE TABLE "scrap_purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"kind" text NOT NULL,
	"karat" smallint NOT NULL,
	"gross_weight_mg" integer NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"scrap_rate_per_gram" bigint NOT NULL,
	"agreed_rate_per_gram" bigint NOT NULL,
	"deviation_bp" integer NOT NULL,
	"override_approved" boolean DEFAULT false NOT NULL,
	"amount" bigint NOT NULL,
	"payment_method" text NOT NULL,
	"item_id" integer,
	"customer_name" text,
	"customer_phone" text,
	"customer_id_ref" text,
	"note" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scrap_purchases_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "scrap_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"karat" smallint NOT NULL,
	"price_per_gram" bigint NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"set_by" integer
);
--> statement-breakpoint
CREATE TABLE "scrap_weight_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"karat" smallint NOT NULL,
	"weight_mg" integer NOT NULL,
	"event_type" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" integer NOT NULL,
	"ref_number" text,
	"actor_id" integer,
	"session_id" text,
	"idempotency_key" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"purchase_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"settled_karat" smallint NOT NULL,
	"settled_weight_mg" integer NOT NULL,
	"settled_pure_mg24" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_settlements_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "gold_debt_mg_pure24" integer;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "gold_owed_mg_pure24" integer;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "making_charge_paid" bigint;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "making_charge_paid_from" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "payment_ref_invoice" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "payment_ref_transaction" text;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "scrap_purchases_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "scrap_purchases_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "scrap_purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "scrap_weight_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "scrap_weight_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "supplier_settlements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrap_purchases_branch_at_idx" ON "scrap_purchases" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "scrap_rates_karat_idx" ON "scrap_rates" USING btree ("karat","effective_at");--> statement-breakpoint
CREATE INDEX "scrap_weight_branch_karat_idx" ON "scrap_weight_entries" USING btree ("branch_id","karat");--> statement-breakpoint
CREATE INDEX "scrap_weight_ref_idx" ON "scrap_weight_entries" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "supplier_settlements_purchase_idx" ON "supplier_settlements" USING btree ("purchase_id");--> statement-breakpoint
ALTER TABLE "sales" DROP CONSTRAINT IF EXISTS "ck_sales_payment_method";--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD')) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" DROP CONSTRAINT IF EXISTS "ck_settlements_payment_method";--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ck_ledger_entries_payment_method";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_payment_method" CHECK (payment_method IS NULL OR payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_accounts" DROP CONSTRAINT IF EXISTS "ck_ledger_accounts_kind";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ck_ledger_accounts_kind" CHECK (kind IN ('CASH', 'BANK', 'FUNDS_IN_TRANSIT', 'HASAD_RECEIVABLE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ck_ledger_entries_event_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'EXPENSE', 'HASAD_SETTLEMENT', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_kind" CHECK (kind IN ('SELLABLE', 'BROKEN')) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER')) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "ck_scrap_weight_entries_event_type" CHECK (event_type IN ('SCRAP_PURCHASE', 'SUPPLIER_SETTLEMENT', 'REVERSAL')) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_making_charge_paid_from" CHECK (making_charge_paid_from IS NULL OR making_charge_paid_from IN ('CASH', 'BANK')) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_rates" ADD CONSTRAINT "ck_scrap_rates_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_rates" ADD CONSTRAINT "ck_scrap_rates_price_per_gram_nonneg" CHECK (price_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_gross_weight_mg_nonneg" CHECK (gross_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_scrap_rate_per_gram_nonneg" CHECK (scrap_rate_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_agreed_rate_per_gram_nonneg" CHECK (agreed_rate_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_deviation_bp_nonneg" CHECK (deviation_bp >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_amount_nonneg" CHECK (amount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_net_positive" CHECK (net_weight_mg > 0 AND net_weight_mg <= gross_weight_mg) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_item_iff_sellable" CHECK ((kind = 'SELLABLE') = (item_id IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "ck_scrap_weight_entries_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "scrap_weight_entries" ADD CONSTRAINT "ck_scrap_weight_entries_weight_nonzero" CHECK (weight_mg <> 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "ck_supplier_settlements_settled_karat_range" CHECK (settled_karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "supplier_settlements" ADD CONSTRAINT "ck_supplier_settlements_positive" CHECK (settled_weight_mg > 0 AND settled_pure_mg24 > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_gold_debt_pair" CHECK ((gold_debt_mg_pure24 IS NULL) = (gold_owed_mg_pure24 IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_gold_owed_range" CHECK (gold_owed_mg_pure24 IS NULL OR (gold_owed_mg_pure24 >= 0 AND gold_owed_mg_pure24 <= gold_debt_mg_pure24)) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_making_charge_paid" CHECK ((making_charge_paid IS NULL) = (making_charge_paid_from IS NULL) AND coalesce(making_charge_paid, 0) >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_hasad_reference" CHECK (payment_method <> 'HASAD' OR payment_ref_invoice IS NOT NULL) NOT VALID;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
           WHERE conname LIKE 'ck\_%' AND contype = 'c' AND NOT convalidated LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'constraint % on % left NOT VALID: existing rows violate it', r.conname, r.tbl;
    END;
  END LOOP;
END $$;--> statement-breakpoint
-- ── HASAD_RECEIVABLE: money a customer paid through the Hasad app, held by Hasad (D-4-6).
INSERT INTO "ledger_accounts" ("branch_id", "kind") SELECT b."id", 'HASAD_RECEIVABLE' FROM "branches" b ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION jerp_branch_ledger_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_accounts (branch_id, kind)
    SELECT NEW.id, k.kind FROM (VALUES ('CASH'), ('BANK'), ('FUNDS_IN_TRANSIT'), ('HASAD_RECEIVABLE')) AS k(kind)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
-- ── Append-only: scrap rates, scrap purchases, the weight pool and supplier settlements.
CREATE TRIGGER scrap_rates_append_only BEFORE UPDATE OR DELETE ON "scrap_rates" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_rates_no_truncate BEFORE TRUNCATE ON "scrap_rates" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_purchases_append_only BEFORE UPDATE OR DELETE ON "scrap_purchases" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_purchases_no_truncate BEFORE TRUNCATE ON "scrap_purchases" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_weight_entries_append_only BEFORE UPDATE OR DELETE ON "scrap_weight_entries" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER scrap_weight_entries_no_truncate BEFORE TRUNCATE ON "scrap_weight_entries" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER supplier_settlements_append_only BEFORE UPDATE OR DELETE ON "supplier_settlements" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER supplier_settlements_no_truncate BEFORE TRUNCATE ON "supplier_settlements" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('scrap_rates');--> statement-breakpoint
SELECT jerp_lock_append_only('scrap_purchases');--> statement-breakpoint
SELECT jerp_lock_append_only('scrap_weight_entries');--> statement-breakpoint
SELECT jerp_lock_append_only('supplier_settlements');--> statement-breakpoint
-- ── Permissions: counter scrap purchases and supplier settlement (branch manager + GM), price override (GM).
INSERT INTO "permissions" ("code", "description") VALUES
  ('scrap.buy', 'Buy scrap gold from customers at the counter (sellable pieces or broken scrap)'),
  ('scrap.override', 'Approve a scrap price beyond the allowed tolerance from the scrap buying rate'),
  ('purchases.settle', 'Record a supplier settlement paid with broken-scrap weight')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('scrap.buy'), ('purchases.settle')) AS p(code)
  WHERE r."code" IN ('GENERAL_MANAGER', 'BRANCH_MANAGER') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'scrap.override' FROM "roles" r WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
