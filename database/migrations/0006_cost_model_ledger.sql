-- Phase 2b: item cost model, sale-line profit snapshot, branch money ledger (docs/decisions.md D-2b-*).
-- Forward-only and non-destructive: new columns are added, backfilled from the existing ones, then made
-- NOT NULL; the old cost columns stay (deprecated). No ledger entry is invented for existing data.
CREATE TABLE "cash_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"business_day" date NOT NULL,
	"counted_amount" bigint NOT NULL,
	"expected_amount" bigint NOT NULL,
	"counted_by" integer NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payment_method" text,
	"ref_type" text NOT NULL,
	"ref_id" integer NOT NULL,
	"ref_number" text,
	"reverses_entry_id" integer,
	"actor_id" integer,
	"session_id" text,
	"idempotency_key" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_from" text;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "origin" text DEFAULT 'SUPPLIER_NEW' NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "acquisition_cost" bigint;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "cost_is_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "supplier_id" integer;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "supplier_invoice_ref" text;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD COLUMN "making_charge" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "acquisition_cost" bigint;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "profit" bigint;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "pricing_mode" text DEFAULT 'FIXED_TAG' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "price_gold_value" bigint;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "price_making_charge" bigint;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "price_rate_per_gram" bigint;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_counts_branch_day_idx" ON "cash_counts" USING btree ("branch_id","business_day","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_branch_kind_idx" ON "ledger_accounts" USING btree ("branch_id","kind");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_at_idx" ON "ledger_entries" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "ledger_entries_branch_at_idx" ON "ledger_entries" USING btree ("branch_id","at");--> statement-breakpoint
CREATE INDEX "ledger_entries_ref_idx" ON "ledger_entries" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_reverses_idx" ON "ledger_entries" USING btree ("reverses_entry_id");--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "jewelry_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A reversing entry must point at an existing entry of the same account with the opposite amount,
-- that is not itself a reversal. Checked by trigger rather than a self-referencing foreign key: the
-- key's row lock (FOR KEY SHARE) would need UPDATE on this append-only table, which nobody has.
CREATE OR REPLACE FUNCTION jerp_ledger_reversal_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  IF NEW.reverses_entry_id IS NULL THEN RETURN NEW; END IF;
  SELECT account_id, amount, reverses_entry_id INTO o FROM ledger_entries WHERE id = NEW.reverses_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger entry % to reverse does not exist', NEW.reverses_entry_id USING ERRCODE = 'foreign_key_violation'; END IF;
  IF o.reverses_entry_id IS NOT NULL THEN RAISE EXCEPTION 'a reversal cannot itself be reversed' USING ERRCODE = 'check_violation'; END IF;
  IF o.account_id <> NEW.account_id OR o.amount <> -NEW.amount THEN
    RAISE EXCEPTION 'a reversal must use the same account and the opposite amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ledger_entries_reversal_check BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION jerp_ledger_reversal_check();--> statement-breakpoint
-- ── Backfill the cost model from the existing (now deprecated) columns.
UPDATE "jewelry_items" SET "acquisition_cost" = "total_cost", "making_charge" = "making_cost" WHERE "acquisition_cost" IS NULL;--> statement-breakpoint
UPDATE "jewelry_items" i SET "supplier_id" = p."supplier_id", "supplier_invoice_ref" = p."supplier_invoice_no"
  FROM "purchases" p WHERE i."purchase_id" = p."id" AND i."supplier_id" IS NULL AND i."supplier_invoice_ref" IS NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ALTER COLUMN "acquisition_cost" SET NOT NULL;--> statement-breakpoint
UPDATE "sale_items" SET "acquisition_cost" = "unit_cost", "profit" = "final_price" - "unit_cost" WHERE "acquisition_cost" IS NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "acquisition_cost" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "profit" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_origin" CHECK (origin IN ('OPENING', 'SUPPLIER_NEW', 'SCRAP')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_pricing_mode" CHECK (pricing_mode IN ('FIXED_TAG', 'COMPUTED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "ck_expenses_paid_from" CHECK (paid_from IS NULL OR paid_from IN ('CASH', 'BANK')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ck_ledger_accounts_kind" CHECK (kind IN ('CASH', 'BANK', 'FUNDS_IN_TRANSIT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'EXPENSE', 'HASAD_SETTLEMENT', 'REVERSAL')) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_payment_method" CHECK (payment_method IS NULL OR payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET')) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_acquisition_cost_nonneg" CHECK (acquisition_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_making_charge_nonneg" CHECK (making_charge >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_making_in_acquisition" CHECK (origin <> 'SUPPLIER_NEW' OR making_charge <= acquisition_cost) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_acquisition_cost_nonneg" CHECK (acquisition_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_profit_sum" CHECK (profit = final_price - acquisition_cost) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_price_components_nonneg" CHECK (coalesce(price_gold_value, 0) >= 0 AND coalesce(price_making_charge, 0) >= 0 AND coalesce(price_rate_per_gram, 0) >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_amount_nonzero" CHECK (amount <> 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_reversal_type" CHECK ((reverses_entry_id IS NULL OR event_type IN ('SALE_VOID', 'REVERSAL')) AND (event_type <> 'REVERSAL' OR reverses_entry_id IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "ck_cash_counts_counted_amount_nonneg" CHECK (counted_amount >= 0) NOT VALID;--> statement-breakpoint
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
-- ── Every branch has a CASH, a BANK and a FUNDS_IN_TRANSIT account: now, and for every future branch.
INSERT INTO "ledger_accounts" ("branch_id", "kind")
  SELECT b."id", k.kind FROM "branches" b CROSS JOIN (VALUES ('CASH'), ('BANK'), ('FUNDS_IN_TRANSIT')) AS k(kind)
  ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION jerp_branch_ledger_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_accounts (branch_id, kind)
    SELECT NEW.id, k.kind FROM (VALUES ('CASH'), ('BANK'), ('FUNDS_IN_TRANSIT')) AS k(kind)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER branches_ledger_accounts AFTER INSERT ON "branches"
  FOR EACH ROW EXECUTE FUNCTION jerp_branch_ledger_accounts();--> statement-breakpoint
-- ── The ledger and the cash counts are append-only (triggers + privileges), like the audit log.
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER cash_counts_append_only BEFORE UPDATE OR DELETE ON "cash_counts"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER cash_counts_no_truncate BEFORE TRUNCATE ON "cash_counts"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_delete BEFORE DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('ledger_entries');--> statement-breakpoint
SELECT jerp_lock_append_only('cash_counts');--> statement-breakpoint
-- ── Permissions: expected cash and daily reconciliation (branch managers: own branch; GM: all).
INSERT INTO "permissions" ("code", "description") VALUES
  ('cash.view', 'See the expected cash in the drawer and the daily cash reconciliation'),
  ('cash.count', 'Record the counted cash of a business day')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('cash.view'), ('cash.count')) AS p(code)
  WHERE r."code" IN ('GENERAL_MANAGER', 'BRANCH_MANAGER')
  ON CONFLICT DO NOTHING;
