-- ── REM-2: Hasad becomes a sales channel only (docs/decisions.md D-rem2-*).
-- Hasad stays as the HASAD payment method (with its references), the HASAD_RECEIVABLE account and its
-- settlement by bank transfer. The withdrawal workspace, counter sessions, weight-difference
-- settlements, simulator and mock integration are removed. Forward-only and non-destructive: the
-- historical tables, columns and the hasad_mock schema stay (REM-5 drops them). What changes:
--   1. pieces still RESERVED by an open counter session are released (nothing else could release them now);
--   2. the hasad.* permissions disappear (reference data, not history);
--   3. new rows in the Hasad tables and new HASAD_SETTLEMENT ledger entries are refused by triggers.

-- 1. Release reservations of open (DRAFT) counter sessions, exactly as an abort did: status history,
--    an audit entry per piece (actor: System), the session ABORTED, the request back to READY_FOR_PICKUP.
CREATE TEMP TABLE "rem2_release" ON COMMIT DROP AS
  SELECT ri.id AS ri_id, i.id AS item_id, i.code AS item_code, i.branch_id, r.id AS redemption_id, r.number AS redemption_number,
         w.id AS withdrawal_id, w.external_id
  FROM "hasad_redemption_items" ri
  JOIN "hasad_redemptions" r ON r.id = ri.redemption_id
  JOIN "hasad_withdrawals" w ON w.id = r.withdrawal_id
  JOIN "jewelry_items" i ON i.id = ri.item_id
  WHERE r.status = 'DRAFT' AND ri.active AND i.status = 'RESERVED';--> statement-breakpoint
INSERT INTO "item_status_history" ("item_id", "from_status", "to_status", "branch_id", "ref_type", "ref_id", "ref_number", "user_id", "note")
  SELECT item_id, 'RESERVED', 'AVAILABLE', branch_id, 'hasad_redemption', redemption_id, redemption_number, NULL,
         'Released: the Hasad withdrawal workspace was removed (REM-2)'
  FROM "rem2_release";--> statement-breakpoint
INSERT INTO "audit_logs" ("username", "user_full_name", "role", "branch_id", "action", "entity_type", "entity_id", "description", "description_key", "description_params", "metadata")
  SELECT 'system', 'System (migration)', 'SYSTEM', branch_id, 'ITEM_RELEASED', 'item', item_code,
         item_code || ' released back to AVAILABLE (the Hasad withdrawal workspace was removed) — withdrawal ' || external_id,
         '{code} released back to AVAILABLE ({note}) — withdrawal {id}',
         jsonb_build_object('code', item_code, 'note', 'the Hasad withdrawal workspace was removed', 'id', external_id),
         jsonb_build_object('withdrawal', external_id, 'redemption', redemption_number, 'migration', '0014')
  FROM "rem2_release";--> statement-breakpoint
UPDATE "jewelry_items" SET "status" = 'AVAILABLE', "reservation_ref" = NULL, "reserved_by" = NULL, "reserved_at" = NULL, "updated_at" = now()
  WHERE "id" IN (SELECT item_id FROM "rem2_release") AND "status" = 'RESERVED';--> statement-breakpoint
UPDATE "hasad_redemption_items" SET "active" = false, "released_at" = now() WHERE "id" IN (SELECT ri_id FROM "rem2_release");--> statement-breakpoint
UPDATE "hasad_withdrawals" SET "status" = 'READY_FOR_PICKUP', "external_status" = 'READY_FOR_PICKUP'
  WHERE "id" IN (SELECT withdrawal_id FROM "hasad_redemptions" WHERE "status" = 'DRAFT') AND "status" = 'IN_PROGRESS';--> statement-breakpoint
UPDATE "hasad_redemptions" SET "status" = 'ABORTED', "aborted_at" = now(), "abort_reason" = 'The Hasad withdrawal workspace was removed (REM-2)'
  WHERE "status" = 'DRAFT';--> statement-breakpoint

-- 2. Permissions.
DELETE FROM "role_permissions" WHERE "permission_code" IN ('hasad.process', 'hasad.view', 'hasad.cancel', 'hasad.simulate');--> statement-breakpoint
DELETE FROM "permissions" WHERE "code" IN ('hasad.process', 'hasad.view', 'hasad.cancel', 'hasad.simulate');--> statement-breakpoint

-- 3. No new rows (function jerp_refuse_deprecated_insert from migration 0013).
CREATE TRIGGER "trg_hasad_withdrawals_deprecated" BEFORE INSERT ON "hasad_withdrawals"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the Hasad withdrawal workspace was removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_hasad_redemptions_deprecated" BEFORE INSERT ON "hasad_redemptions"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the Hasad withdrawal workspace was removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_hasad_redemption_items_deprecated" BEFORE INSERT ON "hasad_redemption_items"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the Hasad withdrawal workspace was removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_settlements_deprecated" BEFORE INSERT ON "settlements"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('Hasad weight-difference settlements were removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_ledger_entries_no_hasad_settlement" BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW WHEN (NEW.event_type = 'HASAD_SETTLEMENT')
  EXECUTE FUNCTION jerp_refuse_deprecated_insert('Hasad weight-difference settlements were removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_hasad_mock_customers_deprecated" BEFORE INSERT ON "hasad_mock"."customers"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the mock Hasad integration was removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_hasad_mock_withdrawals_deprecated" BEFORE INSERT ON "hasad_mock"."withdrawals"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the mock Hasad integration was removed (BACKLOG REM-2)');--> statement-breakpoint
CREATE TRIGGER "trg_hasad_mock_api_calls_deprecated" BEFORE INSERT ON "hasad_mock"."api_calls"
  FOR EACH ROW EXECUTE FUNCTION jerp_refuse_deprecated_insert('the mock Hasad integration was removed (BACKLOG REM-2)');
