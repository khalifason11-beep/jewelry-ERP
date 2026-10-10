-- ── CSH-2 piece A (docs/plans/CSH-2.md §4, docs/decisions.md D-csh-7): split payment on counter scrap purchases.
-- A purchase is paid cash_amount from the drawer + bank_amount by bank transfer (with its reference); payment_method
-- becomes a label derived from the parts (CASH, BANK_TRANSFER or SPLIT). Hand-written from the drizzle-generated column
-- list (the snapshot is the COMPLETE schema), reviewed statement by statement. Every pending migration runs in one
-- transaction: when a guard stops, NOTHING is changed.
--
-- Guard (a): every existing purchase's SCRAP_PURCHASE ledger entries must match its own method and amount, because the
-- backfill writes the parts from the method (CASH → all cash, BANK_TRANSFER → all bank). It never writes "cash = total"
-- for a bank row: that would contradict the ledger and break the reconciliation of past days.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM scrap_purchases p
  WHERE coalesce((SELECT sum(e.amount) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                  WHERE e.ref_type = 'scrap_purchase' AND e.ref_id = p.id AND e.event_type = 'SCRAP_PURCHASE' AND a.kind = 'CASH'), 0)
          <> CASE WHEN p.payment_method = 'CASH' THEN -p.amount ELSE 0 END
     OR coalesce((SELECT sum(e.amount) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                  WHERE e.ref_type = 'scrap_purchase' AND e.ref_id = p.id AND e.event_type = 'SCRAP_PURCHASE' AND a.kind = 'BANK'), 0)
          <> CASE WHEN p.payment_method = 'BANK_TRANSFER' THEN -p.amount ELSE 0 END;
  IF n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0021 (CSH-2) stopped: ' || n || ' scrap purchase(s) do not match their entries in the money ledger.'
        || E'\nNothing was changed. The payment parts are written from each purchase''s own method, which must agree with the ledger.'
        || E'\nThis database holds inconsistent trial data and is recreated, not upgraded (local: delete the PGLITE_DIR folder, default'
        || E'\n.data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "CSH-2".';
  END IF;
END $$;--> statement-breakpoint
-- Guard (b), owner decision Q1: a bank-paid scrap purchase now carries the bank's reference (FIX-2 rules). Purchases
-- recorded before this change never had the field, so a database that holds one stops here, changing nothing, and is
-- recreated (as FIX-2). No marker column, no exception for old rows.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM scrap_purchases WHERE payment_method = 'BANK_TRANSFER';
  IF n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0021 (CSH-2) stopped: ' || n || ' scrap purchase(s) paid by bank transfer have no bank reference (the field is new).'
        || E'\nNothing was changed. Scrap purchases are never rewritten: this database holds trial data from before CSH-2 and is'
        || E'\nrecreated, not upgraded (local: delete the PGLITE_DIR folder, default .data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "CSH-2".';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD COLUMN "cash_amount" bigint;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD COLUMN "bank_amount" bigint;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD COLUMN "bank_reference" text;--> statement-breakpoint
-- The backfill writes the two new columns of an append-only table once. Both locks are lifted for this one statement
-- and put back right below, in the same transaction: the trigger, and the UPDATE privilege that jerp_lock_append_only
-- took from every role including the owner (0005). After this migration no role holds UPDATE again and the trigger
-- fires again (tested on real PostgreSQL: an UPDATE is refused).
GRANT UPDATE ON "scrap_purchases" TO CURRENT_USER;--> statement-breakpoint
-- allow-destructive: one-time backfill of the new payment parts on the append-only scrap_purchases; the trigger is enabled again two statements below, in the same transaction
ALTER TABLE "scrap_purchases" DISABLE TRIGGER "scrap_purchases_append_only";--> statement-breakpoint
UPDATE "scrap_purchases" SET
  "cash_amount" = CASE WHEN "payment_method" = 'CASH' THEN "amount" ELSE 0 END,
  "bank_amount" = CASE WHEN "payment_method" = 'BANK_TRANSFER' THEN "amount" ELSE 0 END;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ENABLE TRIGGER "scrap_purchases_append_only";--> statement-breakpoint
-- allow-destructive: take UPDATE, DELETE and TRUNCATE away again from every role (the grant two statements above included)
SELECT jerp_lock_append_only('scrap_purchases');--> statement-breakpoint
ALTER TABLE "scrap_purchases" ALTER COLUMN "cash_amount" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "scrap_purchases" ALTER COLUMN "bank_amount" SET NOT NULL;--> statement-breakpoint
-- allow-destructive: replace the payment-method CHECK to add SPLIT; every existing row stays valid (validated)
ALTER TABLE "scrap_purchases" DROP CONSTRAINT "ck_scrap_purchases_payment_method";--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'SPLIT'));--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_payment_parts" CHECK (cash_amount >= 0 AND bank_amount >= 0 AND cash_amount + bank_amount = amount);--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_payment_label" CHECK ((payment_method = 'CASH' AND bank_amount = 0) OR (payment_method = 'BANK_TRANSFER' AND cash_amount = 0) OR (payment_method = 'SPLIT' AND cash_amount > 0 AND bank_amount > 0));--> statement-breakpoint
ALTER TABLE "scrap_purchases" ADD CONSTRAINT "ck_scrap_purchases_bank_reference" CHECK (bank_amount = 0 OR (bank_reference IS NOT NULL AND length(btrim(bank_reference)) BETWEEN 4 AND 40));
