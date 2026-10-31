CREATE TABLE "money_transfer_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"transfer_id" integer NOT NULL,
	"kind" text NOT NULL,
	"account" text,
	"bank_reference" text,
	"reason" text,
	"actor_id" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "money_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"from_branch_id" integer NOT NULL,
	"to_kind" text NOT NULL,
	"to_branch_id" integer,
	"source_account" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"bank_reference" text,
	"status" text DEFAULT 'IN_TRANSIT' NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	CONSTRAINT "money_transfers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "money_transfer_events" ADD CONSTRAINT "money_transfer_events_transfer_id_money_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."money_transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_events" ADD CONSTRAINT "money_transfer_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "money_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "money_transfer_events_transfer_idx" ON "money_transfer_events" USING btree ("transfer_id","id");--> statement-breakpoint
CREATE INDEX "money_transfers_from_idx" ON "money_transfers" USING btree ("from_branch_id","status");--> statement-breakpoint
CREATE INDEX "money_transfers_to_idx" ON "money_transfers" USING btree ("to_branch_id","status");--> statement-breakpoint
CREATE INDEX "money_transfers_status_idx" ON "money_transfers" USING btree ("status","created_at");--> statement-breakpoint
-- ── MNY-1 hand-written part (plan docs/plans/MNY-1.md §2). Two new tables, their checks and triggers, four ledger event
-- types (the CHECK is replaced, D-mny1-1), three permissions and their grants (D-mny1-2). No existing row is changed.
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_to_kind" CHECK (to_kind IN ('BRANCH', 'GM'));--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_source_account" CHECK (source_account IN ('CASH', 'BANK'));--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_status" CHECK (status IN ('IN_TRANSIT', 'RECEIVED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_receiver" CHECK ((to_kind = 'BRANCH' AND to_branch_id IS NOT NULL AND to_branch_id <> from_branch_id) OR (to_kind = 'GM' AND to_branch_id IS NULL));--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_amount_positive" CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_reason" CHECK (length(btrim(reason)) BETWEEN 3 AND 300);--> statement-breakpoint
ALTER TABLE "money_transfers" ADD CONSTRAINT "ck_money_transfers_bank_reference" CHECK ((source_account = 'BANK') = (bank_reference IS NOT NULL));--> statement-breakpoint
ALTER TABLE "money_transfer_events" ADD CONSTRAINT "ck_money_transfer_events_kind" CHECK (kind IN ('SENT', 'RECEIVED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "money_transfer_events" ADD CONSTRAINT "ck_money_transfer_events_account" CHECK (account IS NULL OR account IN ('CASH', 'BANK'));--> statement-breakpoint
ALTER TABLE "money_transfer_events" ADD CONSTRAINT "ck_money_transfer_events_shape" CHECK (
  (kind = 'SENT' AND account IS NULL AND reason IS NULL)
  OR (kind = 'RECEIVED' AND reason IS NULL AND (account = 'BANK') = (bank_reference IS NOT NULL))
  OR (kind = 'CANCELLED' AND account IS NULL AND bank_reference IS NULL AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 3 AND 300)
);--> statement-breakpoint
-- One SENT per transfer, and at most one closing step: even a write that skipped the row lock cannot close it twice.
CREATE UNIQUE INDEX "money_transfer_events_sent_uq" ON "money_transfer_events" ("transfer_id") WHERE kind = 'SENT';--> statement-breakpoint
CREATE UNIQUE INDEX "money_transfer_events_closed_uq" ON "money_transfer_events" ("transfer_id") WHERE kind IN ('RECEIVED', 'CANCELLED');--> statement-breakpoint
-- The head of a transfer: its money never changes; the status moves once, from IN_TRANSIT; it is never deleted.
CREATE OR REPLACE FUNCTION jerp_money_transfer_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money_transfers: a transfer is never deleted';
  END IF;
  IF NEW.number <> OLD.number OR NEW.from_branch_id <> OLD.from_branch_id OR NEW.to_kind <> OLD.to_kind
     OR NEW.to_branch_id IS DISTINCT FROM OLD.to_branch_id OR NEW.source_account <> OLD.source_account
     OR NEW.amount <> OLD.amount OR NEW.reason <> OLD.reason OR NEW.bank_reference IS DISTINCT FROM OLD.bank_reference
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'money_transfers: only the status of transfer % may change', OLD.id;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'IN_TRANSIT' AND NEW.status IN ('RECEIVED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'money_transfers: transfer % cannot go from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER money_transfers_guard BEFORE UPDATE OR DELETE ON "money_transfers" FOR EACH ROW EXECUTE FUNCTION jerp_money_transfer_check();--> statement-breakpoint
CREATE TRIGGER money_transfers_no_truncate BEFORE TRUNCATE ON "money_transfers" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- The steps are append-only.
CREATE TRIGGER money_transfer_events_append_only BEFORE UPDATE OR DELETE ON "money_transfer_events" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER money_transfer_events_no_truncate BEFORE TRUNCATE ON "money_transfer_events" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('money_transfer_events');--> statement-breakpoint
-- ── The ledger event types of a transfer (D-mny1-1).
-- allow-destructive: D-mny1-1 replace the event-type CHECK with the wider list (four MONEY_TRANSFER types); every existing row stays valid
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ck_ledger_entries_event_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE', 'GM_ADVANCE', 'GM_REPAYMENT', 'MONEY_TRANSFER_SENT', 'MONEY_TRANSFER_RECEIVED', 'MONEY_TRANSFER_CANCELLED', 'MONEY_TRANSFER_TO_GM'));--> statement-breakpoint
-- A cancel reverses the send's entries (reverses_entry_id), as a sale void does; it must name the entry it reverses.
-- allow-destructive: D-mny1-1 replace the reversal CHECK so a MONEY_TRANSFER_CANCELLED entry may (and must) reverse one; every existing row stays valid
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ck_ledger_entries_reversal_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_reversal_type" CHECK ((reverses_entry_id IS NULL OR event_type IN ('SALE_VOID', 'REVERSAL', 'MONEY_TRANSFER_CANCELLED')) AND (event_type NOT IN ('REVERSAL', 'MONEY_TRANSFER_CANCELLED') OR reverses_entry_id IS NOT NULL));--> statement-breakpoint
-- ── The permissions (D-mny1-2): the branch manager views, sends and receives; the General Manager views and receives
-- (only transfers addressed to him: the services check it); never send. The cashier gets none.
INSERT INTO "permissions" ("code", "description") VALUES
  ('money_transfers.view', 'See the money transfers of the own branch (the General Manager: every branch, read only)'),
  ('money_transfers.send', 'Send money from the own branch to another branch or to the General Manager, and cancel it while in transit'),
  ('money_transfers.receive', 'Confirm the receipt of a money transfer addressed to the own branch (the General Manager: addressed to him)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('money_transfers.view'), ('money_transfers.send'), ('money_transfers.receive')) AS p(code)
  WHERE r."code" = 'BRANCH_MANAGER' ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", p.code FROM "roles" r CROSS JOIN (VALUES ('money_transfers.view'), ('money_transfers.receive')) AS p(code)
  WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
