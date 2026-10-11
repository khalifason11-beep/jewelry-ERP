CREATE TABLE "gm_funding_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"kind" text NOT NULL,
	"account" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"bank_reference" text,
	"paid_directly_to_seller" boolean DEFAULT false NOT NULL,
	"linked_ref" text,
	"reverses_event_id" integer,
	"actor_id" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gm_funding_events_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "gm_funding_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "gm_funding_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gm_funding_events_branch_idx" ON "gm_funding_events" USING btree ("branch_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "gm_funding_events_reverses_idx" ON "gm_funding_events" USING btree ("reverses_event_id");--> statement-breakpoint
-- ── CSH-2 piece B (docs/plans/CSH-2.md §3, docs/decisions.md D-csh-1…): the General Manager's advances to a branch
-- and the branch's repayments. Hand-written below the drizzle-generated table; reviewed statement by statement.
-- Forward-only. No ledger entry is invented (D-2b-8): existing branches only receive an empty OWED_TO_GM account.
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_kind" CHECK (kind IN ('ADVANCE', 'REPAYMENT', 'REVERSAL'));--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_account" CHECK (account IN ('CASH', 'BANK'));--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_amount_positive" CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 300);--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_reversal" CHECK ((kind = 'REVERSAL') = (reverses_event_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_bank_reference" CHECK (kind = 'REVERSAL' OR account <> 'BANK' OR (bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 4 AND 40));--> statement-breakpoint
ALTER TABLE "gm_funding_events" ADD CONSTRAINT "ck_gm_funding_events_linked_ref" CHECK (linked_ref IS NULL OR length(btrim(linked_ref)) BETWEEN 3 AND 40);--> statement-breakpoint
-- A correction must point at an advance or a repayment of the same branch, account and amount (never at another
-- correction). Checked by trigger, like jerp_ledger_reversal_check: a self-referencing foreign key's row lock would
-- need UPDATE on this append-only table, which nobody has.
CREATE OR REPLACE FUNCTION jerp_gm_funding_reversal_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o record;
BEGIN
  IF NEW.reverses_event_id IS NULL THEN RETURN NEW; END IF;
  SELECT branch_id, kind, account, amount INTO o FROM gm_funding_events WHERE id = NEW.reverses_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'funding event % to correct does not exist', NEW.reverses_event_id USING ERRCODE = 'foreign_key_violation'; END IF;
  IF o.kind = 'REVERSAL' THEN RAISE EXCEPTION 'a correction cannot itself be corrected' USING ERRCODE = 'check_violation'; END IF;
  IF o.branch_id <> NEW.branch_id OR o.account <> NEW.account OR o.amount <> NEW.amount THEN
    RAISE EXCEPTION 'a correction must use the same branch, account and amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER gm_funding_events_reversal_check BEFORE INSERT ON "gm_funding_events"
  FOR EACH ROW EXECUTE FUNCTION jerp_gm_funding_reversal_check();--> statement-breakpoint
CREATE TRIGGER gm_funding_events_append_only BEFORE UPDATE OR DELETE ON "gm_funding_events" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER gm_funding_events_no_truncate BEFORE TRUNCATE ON "gm_funding_events" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('gm_funding_events');--> statement-breakpoint
-- ── The OWED_TO_GM account kind: allowed by the check, created for every existing branch (empty) and every new one.
-- allow-destructive: replace the account-kind CHECK to add OWED_TO_GM; every existing row stays valid (validated below)
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ck_ledger_accounts_kind";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ck_ledger_accounts_kind" CHECK (kind IN ('CASH', 'BANK', 'FUNDS_IN_TRANSIT', 'HASAD_RECEIVABLE', 'OWED_TO_GM'));--> statement-breakpoint
INSERT INTO "ledger_accounts" ("branch_id", "kind") SELECT b."id", 'OWED_TO_GM' FROM "branches" b ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION jerp_branch_ledger_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_accounts (branch_id, kind)
    SELECT NEW.id, k.kind FROM (VALUES ('CASH'), ('BANK'), ('FUNDS_IN_TRANSIT'), ('HASAD_RECEIVABLE'), ('OWED_TO_GM')) AS k(kind)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
-- ── The two new ledger event types.
-- allow-destructive: replace the event-type CHECK to add GM_ADVANCE and GM_REPAYMENT; every existing row stays valid (validated)
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ck_ledger_entries_event_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE', 'HASAD_RECEIVABLE_SETTLEMENT', 'GM_ADVANCE', 'GM_REPAYMENT'));--> statement-breakpoint
-- ── The two permissions, General Manager only (D-csh-5).
INSERT INTO "permissions" ("code", "description") VALUES
  ('funding.view', 'See what each branch owes the General Manager and the history of advances and repayments'),
  ('funding.manage', 'Record an advance to a branch, a repayment from a branch, or correct one of them')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('funding.view'), ('funding.manage')) AS p(code)
  WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
