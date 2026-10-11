-- ── FIX-2 (docs/plans/POS-FIXES.md §3, docs/decisions.md D-fix-2): a bank-transfer sale carries its bank reference.
-- The reference lives in the existing sales.payment_ref_transaction (for Hasad it already means "transaction
-- reference"); HASAD rows and ck_sales_hasad_reference are not touched.
--
-- Why a VALIDATED check and not NOT VALID: in PostgreSQL a NOT VALID check is still enforced on every later UPDATE of
-- a row, so voiding or reprinting an old bank sale without a reference would start failing. A validated check
-- instead proves every row complies. Before the first production deployment no bank sale without a reference
-- exists; if this database holds one, the migration stops here (like 0016) and, because every pending migration
-- runs in one transaction, NOTHING is changed. No sale is rewritten.
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM sales
    WHERE payment_method = 'BANK_TRANSFER' AND (payment_ref_transaction IS NULL OR length(btrim(payment_ref_transaction)) NOT BETWEEN 4 AND 40);
  IF n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0018 (FIX-2) stopped: ' || n || ' bank-transfer sale(s) have no valid bank reference (4 to 40 characters).'
        || E'\nNothing was changed. Sales are never rewritten: this database holds trial data from before FIX-2 and is'
        || E'\nrecreated, not upgraded (local: delete the PGLITE_DIR folder, default .data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "FIX-2".';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_bank_transfer_reference" CHECK (payment_method <> 'BANK_TRANSFER' OR (payment_ref_transaction IS NOT NULL AND length(btrim(payment_ref_transaction)) BETWEEN 4 AND 40));
