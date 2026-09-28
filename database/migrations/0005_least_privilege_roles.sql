-- Least-privilege database roles (docs/decisions.md D-2a-13, docs/DEPLOYMENT.md).
-- jerp_lock_append_only(table): take UPDATE, DELETE and TRUNCATE on an append-only table away from
-- EVERY role that holds them (PUBLIC, the owner, and any runtime role that received them through a
-- GRANT or through ALTER DEFAULT PRIVILEGES). Called for every append-only table, now and by the
-- migrations that create new ones. Triggers (0003/0004) still refuse the statements for everyone.
CREATE OR REPLACE FUNCTION jerp_lock_append_only(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g record;
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM PUBLIC', tbl);
  FOR g IN
    SELECT DISTINCT pg_get_userbyid(a.grantee) AS role
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = tbl AND a.grantee <> 0 AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM %I', tbl, g.role);
  END LOOP;
END $$;--> statement-breakpoint
SELECT jerp_lock_append_only('audit_logs');--> statement-breakpoint
SELECT jerp_lock_append_only('inventory_movements');--> statement-breakpoint
SELECT jerp_lock_append_only('item_status_history');--> statement-breakpoint
SELECT jerp_lock_append_only('gold_rates');--> statement-breakpoint
SELECT jerp_lock_append_only('settings_history');
