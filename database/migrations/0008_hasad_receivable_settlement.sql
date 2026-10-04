CREATE TABLE "hasad_receivable_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"bank_reference" text,
	"note" text,
	"actor_id" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hasad_receivable_settlements_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "hasad_receivable_settlements" ADD CONSTRAINT "hasad_receivable_settlements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_receivable_settlements" ADD CONSTRAINT "hasad_receivable_settlements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hasad_receivable_settlements_branch_idx" ON "hasad_receivable_settlements" USING btree ("branch_id","at");--> statement-breakpoint
-- ── Phase 4 follow-up: Hasad pays the shop by bank transfer. A settlement moves the amount received
-- from HASAD_RECEIVABLE to BANK (two ledger entries in one transaction). Forward-only, no backfill.
ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ck_ledger_entries_event_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'EXPENSE', 'HASAD_SETTLEMENT', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE', 'HASAD_RECEIVABLE_SETTLEMENT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_receivable_settlements" ADD CONSTRAINT "ck_hasad_receivable_settlements_amount_positive" CHECK (amount > 0) NOT VALID;--> statement-breakpoint
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
CREATE TRIGGER hasad_receivable_settlements_append_only BEFORE UPDATE OR DELETE ON "hasad_receivable_settlements" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER hasad_receivable_settlements_no_truncate BEFORE TRUNCATE ON "hasad_receivable_settlements" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('hasad_receivable_settlements');--> statement-breakpoint
INSERT INTO "permissions" ("code", "description") VALUES
  ('cash.settle_hasad', 'Record a Hasad bank transfer received: moves the amount from the Hasad receivable to the bank')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'cash.settle_hasad' FROM "roles" r WHERE r."code" IN ('GENERAL_MANAGER', 'BRANCH_MANAGER') ON CONFLICT DO NOTHING;
