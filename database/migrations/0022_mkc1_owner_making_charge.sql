-- ── MKC-1 (docs/plans/MKC-1.md, docs/decisions.md D-mkc-*): a supplier order's making charge is paid by the owner, by
-- one bank transfer from his PERSONAL account. No branch money moves and the branch owes nothing, so an order now
-- records the payment fact only (OWNER_PERSONAL, the transfer reference, the transfer date) and posts no ledger entry.
-- Creating a supplier order becomes General-Manager-only. Hand-written around the drizzle-generated columns (the
-- snapshot is the COMPLETE schema), reviewed statement by statement. Every pending migration runs in one transaction:
-- when the guard stops, NOTHING is changed (columns, checks and permission rows alike).
--
-- Guard (owner decision Q8): every supplier order recorded since Phase 4 says its making charge was paid from the
-- branch drawer (CASH, with a CASH ledger entry) or the branch bank (BANK, with no reference ever stored). Rewriting
-- them as "paid by the owner" would contradict their ledger entries, and keeping them would leave two meanings of a
-- making charge in one database. Such a database holds trial data and is recreated, not upgraded (pre-production
-- only: D-mkc-5). The message counts each kind:
--   (a) paid from the drawer:         making_charge_paid_from = 'CASH' AND making_charge_paid > 0
--   (b) paid from the bank:           making_charge_paid_from = 'BANK' AND making_charge_paid > 0 (no reference)
--   (c) a charge of 0 with a source:  making_charge_paid_from IN ('CASH', 'BANK') AND making_charge_paid = 0
--   (d) recorded before Phase 4:      making_charge_paid_from IS NULL
DO $$
DECLARE
  a bigint;
  b bigint;
  c bigint;
  d bigint;
BEGIN
  SELECT count(*) FILTER (WHERE making_charge_paid_from = 'CASH' AND making_charge_paid > 0),
         count(*) FILTER (WHERE making_charge_paid_from = 'BANK' AND making_charge_paid > 0),
         count(*) FILTER (WHERE making_charge_paid_from IN ('CASH', 'BANK') AND coalesce(making_charge_paid, 0) = 0),
         count(*) FILTER (WHERE making_charge_paid_from IS NULL)
    INTO a, b, c, d
    FROM purchases;
  IF a + b + c + d > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0022 (MKC-1) stopped: this database holds ' || (a + b + c + d) || ' supplier order(s) whose making charge was paid from branch money:'
        || E'\n  ' || a || ' paid from the drawer, ' || b || ' paid from the bank (no transfer reference), '
        || c || ' with a charge of 0 and a branch source, ' || d || ' recorded before Phase 4.'
        || E'\nNothing was changed. Since MKC-1 the owner pays making charges from his personal account and an order moves no'
        || E'\nbranch money; orders are never rewritten. This database holds trial data and is recreated, not upgraded (local:'
        || E'\ndelete the PGLITE_DIR folder, default .data/pglite; server: a new database and the bootstrap).',
      HINT = 'docs/DEPLOYMENT.md, section "MKC-1".';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "making_charge_reference" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "making_charge_transfer_date" date;--> statement-breakpoint
-- allow-destructive: replace the payment-source CHECK (CASH, BANK) with OWNER_PERSONAL; the guard above proved no row holds another value (validated)
ALTER TABLE "purchases" DROP CONSTRAINT "ck_purchases_making_charge_paid_from";--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_making_charge_paid_from" CHECK (making_charge_paid_from IS NULL OR making_charge_paid_from IN ('OWNER_PERSONAL'));--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_making_charge_transfer" CHECK ((coalesce(making_charge_paid, 0) = 0 AND making_charge_reference IS NULL AND making_charge_transfer_date IS NULL) OR (making_charge_paid > 0 AND making_charge_reference IS NOT NULL AND length(btrim(making_charge_reference)) BETWEEN 4 AND 40 AND making_charge_transfer_date IS NOT NULL));--> statement-breakpoint
-- Creating a supplier order is General-Manager-only (client fact 5, owner decision Q9). Runs after the guard, in the same
-- transaction, so a stop leaves every grant untouched. The permission itself stays (the General Manager holds it).
-- allow-destructive: take purchases.create away from every role except GENERAL_MANAGER (reference data, not business history)
DELETE FROM "role_permissions"
  WHERE "permission_code" = 'purchases.create'
    AND "role_id" NOT IN (SELECT "id" FROM "roles" WHERE "code" = 'GENERAL_MANAGER');
