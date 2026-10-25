-- ── PAY-1 backfill (plan docs/plans/PAY-1.md §1.3, D-pay1-2): one payment line per existing sale, line 1, its own
-- method, the whole total and its references. Sales are never rewritten. Every pending migration runs in one
-- transaction: when a guard stops, NOTHING is changed.
--
-- Guard (a): a sale's own SALE ledger entries must agree with it (their sum is its total and every entry carries its
-- method). A sale recorded before the ledger existed has no entry and is converted from its own method.
DO $$
DECLARE
  n bigint;
  sample text;
BEGIN
  SELECT count(*), string_agg(number, ', ' ORDER BY id) FILTER (WHERE rn <= 10) INTO n, sample FROM (
    SELECT s.id, s.number, row_number() OVER (ORDER BY s.id) AS rn FROM sales s
    WHERE EXISTS (SELECT 1 FROM ledger_entries e WHERE e.ref_type = 'sale' AND e.ref_id = s.id AND e.event_type = 'SALE')
      AND (
        (SELECT sum(e.amount) FROM ledger_entries e WHERE e.ref_type = 'sale' AND e.ref_id = s.id AND e.event_type = 'SALE') <> s.total
        OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.ref_type = 'sale' AND e.ref_id = s.id AND e.event_type = 'SALE'
                   AND e.payment_method IS DISTINCT FROM s.payment_method)
      )
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0034 (PAY-1) stopped: ' || n || ' sale(s) do not match their entries in the money ledger (' || sample || ').'
        || E'\nNothing was changed. The payment line of each sale is written from its own method and total, which must agree with the ledger.'
        || E'\nThis database holds inconsistent trial data and is recreated, not upgraded (local: delete the PGLITE_DIR folder, default'
        || E'\n.data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "PAY-1".';
  END IF;
END $$;--> statement-breakpoint
-- Guard (b): every sale must make a valid line (a total above 0; a Hasad invoice number on a HASAD sale; a 4–40
-- character bank reference on a BANK_TRANSFER sale; no reference on another method). Impossible after 0014 and 0018,
-- checked anyway.
DO $$
DECLARE
  n bigint;
  sample text;
BEGIN
  SELECT count(*), string_agg(number, ', ' ORDER BY id) FILTER (WHERE rn <= 10) INTO n, sample FROM (
    SELECT s.id, s.number, row_number() OVER (ORDER BY s.id) AS rn FROM sales s
    WHERE s.total <= 0
       OR s.payment_method NOT IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD')
       OR (s.payment_method = 'HASAD' AND (s.payment_ref_invoice IS NULL OR btrim(s.payment_ref_invoice) = ''))
       OR (s.payment_method = 'BANK_TRANSFER' AND (s.payment_ref_invoice IS NOT NULL OR s.payment_ref_transaction IS NULL OR length(btrim(s.payment_ref_transaction)) NOT BETWEEN 4 AND 40))
       OR (s.payment_method NOT IN ('HASAD', 'BANK_TRANSFER') AND (s.payment_ref_invoice IS NOT NULL OR s.payment_ref_transaction IS NOT NULL))
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0034 (PAY-1) stopped: ' || n || ' sale(s) cannot be given a valid payment line (' || sample || ').'
        || E'\nNothing was changed. Sales are never rewritten: this database holds trial data that breaks the payment rules and is'
        || E'\nrecreated, not upgraded (local: delete the PGLITE_DIR folder, default .data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "PAY-1".';
  END IF;
END $$;--> statement-breakpoint
INSERT INTO "sale_payments" ("sale_id", "line_no", "method", "amount", "ref_invoice", "ref_transaction", "created_at")
  SELECT s."id", 1, s."payment_method", s."total",
         CASE WHEN s."payment_method" = 'HASAD' THEN s."payment_ref_invoice" END,
         CASE WHEN s."payment_method" IN ('HASAD', 'BANK_TRANSFER') THEN s."payment_ref_transaction" END,
         s."created_at"
  FROM "sales" s
  WHERE NOT EXISTS (SELECT 1 FROM "sale_payments" p WHERE p."sale_id" = s."id")
  ORDER BY s."id";
