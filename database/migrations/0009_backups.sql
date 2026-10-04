CREATE TABLE "backup_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"file_name" text,
	"size_bytes" bigint,
	"sha256" text,
	"encrypted" boolean DEFAULT false NOT NULL,
	"uploaded" boolean DEFAULT false NOT NULL,
	"detail" jsonb,
	"host" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "backup_runs_kind_idx" ON "backup_runs" USING btree ("kind","status","finished_at");--> statement-breakpoint
-- ── Phase 2c: backups. One append-only row per backup / restore-drill run (the health check reads
-- the latest SUCCESS of each kind). Forward-only, no backfill.
ALTER TABLE "backup_runs" ADD CONSTRAINT "ck_backup_runs_kind" CHECK (kind IN ('BACKUP', 'VERIFY')) NOT VALID;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "ck_backup_runs_status" CHECK (status IN ('SUCCESS', 'FAILURE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "ck_backup_runs_size_nonneg" CHECK (size_bytes IS NULL OR size_bytes >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "ck_backup_runs_finished_after_start" CHECK (finished_at >= started_at) NOT VALID;--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint
           WHERE conname LIKE 'ck\_%' AND contype = 'c' AND NOT convalidated LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', r.tbl, r.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'constraint % on % left NOT VALID: existing rows violate it', r.conname, r.tbl;
    END;
  END LOOP;
END $$;--> statement-breakpoint
CREATE TRIGGER backup_runs_append_only BEFORE UPDATE OR DELETE ON "backup_runs" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER backup_runs_no_truncate BEFORE TRUNCATE ON "backup_runs" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('backup_runs');--> statement-breakpoint
INSERT INTO "permissions" ("code", "description") VALUES
  ('backups.view', 'See the age and status of the latest backup and restore drill')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'backups.view' FROM "roles" r WHERE r."code" = 'GENERAL_MANAGER' ON CONFLICT DO NOTHING;
