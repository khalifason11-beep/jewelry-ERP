CREATE TABLE "branding_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by" integer,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb NOT NULL,
	"version" integer NOT NULL,
	"actor_id" integer,
	"actor_username" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "branding_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_history_key_idx" ON "settings_history" USING btree ("key","at");--> statement-breakpoint
-- settings_history is append-only: history can never be edited or removed.
CREATE OR REPLACE FUNCTION jerp_forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
CREATE TRIGGER settings_history_append_only BEFORE UPDATE OR DELETE ON "settings_history"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER settings_history_no_truncate BEFORE TRUNCATE ON "settings_history"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- Branch codes are business identifiers (document numbers, Hasad mapping): never renamed.
CREATE OR REPLACE FUNCTION jerp_branch_code_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'branch code is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER branches_code_immutable BEFORE UPDATE ON "branches"
  FOR EACH ROW EXECUTE FUNCTION jerp_branch_code_immutable();--> statement-breakpoint
-- Backfill: explode the legacy `system` blob into one row per registry key (the blob row stays, deprecated).
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'company.nameEn', "value" #> '{company,name}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{company,name}' IS NOT NULL AND jsonb_typeof("value" #> '{company,name}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'company.nameAr', "value" #> '{company,nameAr}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{company,nameAr}' IS NOT NULL AND jsonb_typeof("value" #> '{company,nameAr}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'company.currencyCode', "value" #> '{company,currency}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{company,currency}' IS NOT NULL AND jsonb_typeof("value" #> '{company,currency}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'company.timezone', "value" #> '{company,timezone}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{company,timezone}' IS NOT NULL AND jsonb_typeof("value" #> '{company,timezone}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'sales.maxDiscountPercentByRole', "value" #> '{sales,maxDiscountPercentByRole}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{sales,maxDiscountPercentByRole}' IS NOT NULL AND jsonb_typeof("value" #> '{sales,maxDiscountPercentByRole}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'expenses.approvalThreshold', "value" #> '{expenses,approvalThreshold}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{expenses,approvalThreshold}' IS NOT NULL AND jsonb_typeof("value" #> '{expenses,approvalThreshold}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'hasad.settlementBasis', "value" #> '{hasad,settlementBasis}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{hasad,settlementBasis}' IS NOT NULL AND jsonb_typeof("value" #> '{hasad,settlementBasis}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'hasad.rateSource', "value" #> '{hasad,rateSource}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{hasad,rateSource}' IS NOT NULL AND jsonb_typeof("value" #> '{hasad,rateSource}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'hasad.entitlementKarat', "value" #> '{hasad,entitlementKarat}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{hasad,entitlementKarat}' IS NOT NULL AND jsonb_typeof("value" #> '{hasad,entitlementKarat}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'hasad.reservationTimeoutMinutes', "value" #> '{hasad,reservationTimeoutMinutes}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{hasad,reservationTimeoutMinutes}' IS NOT NULL AND jsonb_typeof("value" #> '{hasad,reservationTimeoutMinutes}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.allowSelfPasswordChange', "value" #> '{security,allowSelfPasswordChange}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,allowSelfPasswordChange}' IS NOT NULL AND jsonb_typeof("value" #> '{security,allowSelfPasswordChange}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.sessionIdleMinutes', "value" #> '{security,sessionIdleMinutes}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,sessionIdleMinutes}' IS NOT NULL AND jsonb_typeof("value" #> '{security,sessionIdleMinutes}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.sessionAbsoluteHours', "value" #> '{security,sessionAbsoluteHours}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,sessionAbsoluteHours}' IS NOT NULL AND jsonb_typeof("value" #> '{security,sessionAbsoluteHours}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.minPasswordLength', "value" #> '{security,minPasswordLength}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND jsonb_typeof("value" #> '{security,minPasswordLength}') = 'number'
    -- A legacy value below the Phase 1a floor (10) is not carried over; the stricter default applies.
    AND ("value" #>> '{security,minPasswordLength}')::numeric >= 10
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.lockoutThreshold', "value" #> '{security,lockoutThreshold}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,lockoutThreshold}' IS NOT NULL AND jsonb_typeof("value" #> '{security,lockoutThreshold}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.lockoutBaseMinutes', "value" #> '{security,lockoutBaseMinutes}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,lockoutBaseMinutes}' IS NOT NULL AND jsonb_typeof("value" #> '{security,lockoutBaseMinutes}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'security.lockoutMaxMinutes', "value" #> '{security,lockoutMaxMinutes}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{security,lockoutMaxMinutes}' IS NOT NULL AND jsonb_typeof("value" #> '{security,lockoutMaxMinutes}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'mockHasad.latencyMs', "value" #> '{mockHasad,latencyMs}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{mockHasad,latencyMs}' IS NOT NULL AND jsonb_typeof("value" #> '{mockHasad,latencyMs}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'mockHasad.simulateOutage', "value" #> '{mockHasad,simulateOutage}', 1, "updated_at", "updated_by" FROM "settings"
  WHERE "key" = 'system' AND "value" #> '{mockHasad,simulateOutage}' IS NOT NULL AND jsonb_typeof("value" #> '{mockHasad,simulateOutage}') <> 'null'
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Keep Hasad enabled only for branches that have actually processed Hasad withdrawals
-- (demo data). Every other branch stays disabled, the conservative default.
INSERT INTO "settings" ("key", "value", "version")
  SELECT 'hasad.enabledPerBranch', COALESCE(jsonb_object_agg(b."code", true), '{}'::jsonb), 1 FROM "branches" b
  WHERE EXISTS (SELECT 1 FROM "hasad_withdrawals" w WHERE w."branch_id" = b."id")
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Q14/Q15 permission changes on existing role grants:
--   cashiers lose hasad.cancel (manager-only), branch managers gain it and lose profit.view (GM only).
DELETE FROM "role_permissions" WHERE "permission_code" = 'hasad.cancel'
  AND "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'CASHIER');--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission_code" = 'profit.view'
  AND "role_id" IN (SELECT "id" FROM "roles" WHERE "code" = 'BRANCH_MANAGER');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'hasad.cancel' FROM "roles" r
  WHERE r."code" = 'BRANCH_MANAGER' AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."code" = 'hasad.cancel')
  ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- New permission for branch management (General Manager).
INSERT INTO "permissions" ("code", "description") VALUES ('branches.manage', 'Create and edit branches') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'branches.manage' FROM "roles" r WHERE r."code" = 'GENERAL_MANAGER'
  ON CONFLICT DO NOTHING;
