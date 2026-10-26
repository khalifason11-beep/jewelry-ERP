-- ── PAY-1 tighten (plan docs/plans/PAY-1.md §1.3, D-pay1-1, D-pay1-3). After 0034 every sale has its payment line.
--
-- (1) At commit, every sale has 1 or 2 payment lines (numbered from 1), their sum is its total, and its label is the
--     line's method (one line) or SPLIT (two lines). A constraint trigger DEFERRABLE INITIALLY DEFERRED: the sale and
--     its lines are written in one transaction, in any order, and checked when it commits. It also fires when a sale's
--     total or label is changed, so neither can drift from the lines.
CREATE OR REPLACE FUNCTION jerp_sale_payments_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sid integer;
  s record;
  n integer;
  paid bigint;
  first_line integer;
  methods text[];
  label text;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    sid := NEW.id;
  ELSE
    sid := NEW.sale_id;
  END IF;
  SELECT total, payment_method INTO s FROM sales WHERE id = sid;
  SELECT count(*), coalesce(sum(amount), 0), min(line_no), array_agg(method ORDER BY line_no)
    INTO n, paid, first_line, methods FROM sale_payments WHERE sale_id = sid;
  label := CASE WHEN n = 2 THEN 'SPLIT' ELSE methods[1] END;
  IF n NOT BETWEEN 1 AND 2 OR first_line <> 1 OR paid <> s.total OR s.payment_method IS DISTINCT FROM label THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation',
      MESSAGE = format('sale %s: %s payment line(s) summing to %s do not match its total %s and its label %s', sid, n, paid, s.total, s.payment_method);
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_payments_match AFTER INSERT OR UPDATE OF total, payment_method ON "sales"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jerp_sale_payments_check();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_payments_match AFTER INSERT ON "sale_payments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jerp_sale_payments_check();--> statement-breakpoint
-- (2) The references live on the payment lines (ck_sale_payments_references, 0033); the sale's own reference columns
--     keep their history and are no longer written, so their two checks are replaced by the line check.
-- allow-destructive: D-pay1-3 the Hasad invoice number is required on the HASAD payment line (ck_sale_payments_references) instead
ALTER TABLE "sales" DROP CONSTRAINT "ck_sales_hasad_reference";--> statement-breakpoint
-- allow-destructive: D-pay1-3 the bank reference is required on the BANK_TRANSFER payment line (ck_sale_payments_references) instead
ALTER TABLE "sales" DROP CONSTRAINT "ck_sales_bank_transfer_reference";
