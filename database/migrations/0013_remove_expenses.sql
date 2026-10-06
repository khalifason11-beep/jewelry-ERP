-- ── REM-1: expenses are removed from the product (docs/decisions.md D-rem1-*).
-- Forward-only and non-destructive for business data: the `expenses` table, its CHECKs and the
-- EXPENSE ledger event type stay so history remains valid (REM-5 drops them before the first
-- production deployment). What changes:
--   1. the expenses.* permissions disappear (reference data, not history);
--   2. new expense rows and new EXPENSE ledger entries are refused by triggers.
DELETE FROM "role_permissions" WHERE "permission_code" IN ('expenses.view', 'expenses.create', 'expenses.approve');--> statement-breakpoint
DELETE FROM "permissions" WHERE "code" IN ('expenses.view', 'expenses.create', 'expenses.approve');--> statement-breakpoint
-- One function for every deprecated table or event type; TG_ARGV[0] says what was removed.
CREATE OR REPLACE FUNCTION jerp_refuse_deprecated_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% (%): no new rows', TG_ARGV[0], TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation', HINT = 'This feature was removed; see docs/BACKLOG.md.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "trg_expenses_deprecated" BEFORE INSERT ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('expenses were removed (BACKLOG REM-1)');--> statement-breakpoint
CREATE TRIGGER "trg_ledger_entries_no_expense" BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW WHEN (NEW.event_type = 'EXPENSE')
  EXECUTE FUNCTION jerp_refuse_deprecated_insert('expenses were removed (BACKLOG REM-1)');
