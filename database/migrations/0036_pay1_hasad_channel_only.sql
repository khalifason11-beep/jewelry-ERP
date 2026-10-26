-- ── PAY-1 / HSD-2 (plan docs/plans/PAY-1.md §4, owner answer Q5, decisions D-pay1-4 and D-pay1-8): Hasad is a sales
-- channel only. Hasad money is paid to the General Manager's own account, never the branch's, so the per-branch
-- HASAD_RECEIVABLE account, its settlement by bank transfer (table hasad_receivable_settlements, event
-- HASAD_RECEIVABLE_SETTLEMENT, permission cash.settle_hasad) are removed. Every pending migration runs in one
-- transaction: when the guard stops, NOTHING is changed.
--
-- Guard (owner Q5): the receivable cannot be converted. A Hasad sale posted an entry on it, and a voided one two
-- entries that net to zero; deleting any of them would delete history. So the upgrade stops, changing nothing, on ANY
-- entry on a HASAD_RECEIVABLE account, any settlement entry or record, or any settlement in the audit log. There is no
-- production database: such a database is recreated (DEPLOYMENT.md, "PAY-1").
DO $$
DECLARE
  entries bigint;
  settlements bigint;
  settlement_entries bigint;
  audits bigint;
BEGIN
  SELECT count(*) INTO entries FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.kind = 'HASAD_RECEIVABLE';
  SELECT count(*) INTO settlements FROM hasad_receivable_settlements;
  SELECT count(*) INTO settlement_entries FROM ledger_entries WHERE event_type = 'HASAD_RECEIVABLE_SETTLEMENT';
  SELECT count(*) INTO audits FROM audit_logs WHERE action = 'HASAD_RECEIVABLE_SETTLED';
  IF entries + settlements + settlement_entries + audits > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'restrict_violation',
      MESSAGE = 'Migration 0036 (PAY-1) stopped: this database holds Hasad receivable history that cannot be converted:'
        || E'\n  entries on a Hasad receivable account: ' || entries
        || E'\n  Hasad bank-transfer settlements: ' || settlements
        || E'\n  settlement entries in the money ledger: ' || settlement_entries
        || E'\n  settlements in the audit log: ' || audits
        || E'\nNothing was changed. Hasad money is now paid to the General Manager''s account, never the branch''s, and history'
        || E'\nis never deleted: this database holds trial data and is recreated, not upgraded (local: delete the PGLITE_DIR folder,'
        || E'\ndefault .data/pglite; server: a new database and `npm run bootstrap`).',
      HINT = 'docs/DEPLOYMENT.md, section "PAY-1".';
  END IF;
END $$;--> statement-breakpoint
-- New branches get CASH, BANK, FUNDS_IN_TRANSIT and OWED_TO_GM only.
CREATE OR REPLACE FUNCTION jerp_branch_ledger_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ledger_accounts (branch_id, kind)
    SELECT NEW.id, k.kind FROM (VALUES ('CASH'), ('BANK'), ('FUNDS_IN_TRANSIT'), ('OWED_TO_GM')) AS k(kind)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
-- The empty receivable accounts are deleted once. The no-delete protection of ledger_accounts is lifted for this one
-- statement and put back right below, in the same transaction (tested: a DELETE is refused afterwards). On real
-- PostgreSQL the foreign-key check of that DELETE reads ledger_entries FOR KEY SHARE, which needs the UPDATE privilege
-- jerp_lock_append_only took from every role (0005): it is granted to the migrating role for this statement and taken
-- away again right after it (tested on real PostgreSQL: no role holds UPDATE on ledger_entries afterwards).
GRANT UPDATE ON "ledger_entries" TO CURRENT_USER;--> statement-breakpoint
-- allow-destructive: D-pay1-4 lift the no-delete trigger of ledger_accounts for the one DELETE below; enabled again right after it
ALTER TABLE "ledger_accounts" DISABLE TRIGGER "ledger_accounts_no_delete";--> statement-breakpoint
-- allow-destructive: D-pay1-4 the per-branch HASAD_RECEIVABLE accounts, every one empty (the guard proved no entry uses them)
DELETE FROM "ledger_accounts" WHERE "kind" = 'HASAD_RECEIVABLE';--> statement-breakpoint
ALTER TABLE "ledger_accounts" ENABLE TRIGGER "ledger_accounts_no_delete";--> statement-breakpoint
-- allow-destructive: D-pay1-4 take UPDATE, DELETE and TRUNCATE away again from every role (the grant four statements above included)
SELECT jerp_lock_append_only('ledger_entries');--> statement-breakpoint
-- allow-destructive: D-pay1-4 replace the account-kind CHECK without HASAD_RECEIVABLE (no row uses it any more)
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ck_ledger_accounts_kind";--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ck_ledger_accounts_kind" CHECK (kind IN ('CASH', 'BANK', 'FUNDS_IN_TRANSIT', 'OWED_TO_GM'));--> statement-breakpoint
-- allow-destructive: D-pay1-4 replace the event-type CHECK without HASAD_RECEIVABLE_SETTLEMENT (the guard proved no row uses it)
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ck_ledger_entries_event_type";--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ck_ledger_entries_event_type" CHECK (event_type IN ('SALE', 'SALE_VOID', 'REVERSAL', 'SCRAP_PURCHASE', 'SUPPLIER_MAKING_CHARGE', 'GM_ADVANCE', 'GM_REPAYMENT'));--> statement-breakpoint
-- allow-destructive: D-pay1-4 the empty append-only table of Hasad bank-transfer settlements (the guard proved it has no row); its check, index and triggers go with it
DROP TABLE "hasad_receivable_settlements";--> statement-breakpoint
-- allow-destructive: D-pay1-4 the permission to record a Hasad bank transfer, with its grants (the action no longer exists)
DELETE FROM "role_permissions" WHERE "permission_code" = 'cash.settle_hasad';--> statement-breakpoint
-- allow-destructive: D-pay1-4 the permission to record a Hasad bank transfer (the action no longer exists)
DELETE FROM "permissions" WHERE "code" = 'cash.settle_hasad';
