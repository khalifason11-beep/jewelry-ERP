ALTER TABLE "users" ADD COLUMN "security_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "security_lock_reason" text;--> statement-breakpoint
-- ── Phase 2fa follow-up: security lock (D-2fa-13). Additive only: two nullable columns; no account is locked by the migration.
ALTER TABLE "users" ADD CONSTRAINT "ck_users_security_lock_reason" CHECK ((security_locked_at IS NULL) = (security_lock_reason IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" VALIDATE CONSTRAINT "ck_users_security_lock_reason";
