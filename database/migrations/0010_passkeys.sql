CREATE TABLE "login_pending" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code_hash" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sign_in_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text,
	"method" text NOT NULL,
	"credential_id" integer,
	"credential_nickname" text,
	"browser" text,
	"ip_approx" text,
	"uv" boolean,
	"new_device" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text,
	"pending_id" text,
	"challenge_hash" text NOT NULL,
	"rp_id" text NOT NULL,
	"origin" text NOT NULL,
	"nickname" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_challenge_hash_unique" UNIQUE("challenge_hash")
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"nickname" text NOT NULL,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"uv_at_registration" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "sign_in_method" text DEFAULT 'PASSWORD' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "passkey_reauth_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "passkey_reauth_uv" boolean;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "webauthn_user_handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_failed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes_generated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_pending" ADD CONSTRAINT "login_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_events" ADD CONSTRAINT "sign_in_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_events" ADD CONSTRAINT "sign_in_events_credential_id_webauthn_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."webauthn_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sign_in_events_user_idx" ON "sign_in_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_idx" ON "webauthn_challenges" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_idx" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webauthn_user_handle_unique" UNIQUE("webauthn_user_handle");--> statement-breakpoint
-- ── Phase 2fa: passkeys as a second factor. Additive only: new tables and nullable / defaulted
-- columns; no row is created for anybody (nobody is enrolled by the migration).
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_sign_in_method" CHECK (sign_in_method IN ('PASSWORD', 'PASSKEY', 'RECOVERY_CODE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sign_in_events" ADD CONSTRAINT "ck_sign_in_events_method" CHECK (method IN ('PASSWORD', 'PASSKEY', 'RECOVERY_CODE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "ck_webauthn_challenges_purpose" CHECK (purpose IN ('REGISTER', 'LOGIN', 'STEPUP')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "ck_webauthn_challenges_binding" CHECK ((session_id IS NOT NULL) <> (pending_id IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "ck_webauthn_credentials_nickname" CHECK (length(btrim(nickname)) BETWEEN 1 AND 60) NOT VALID;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "ck_webauthn_credentials_sign_count_nonneg" CHECK (sign_count >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_mfa_failed_count_nonneg" CHECK (mfa_failed_count >= 0) NOT VALID;--> statement-breakpoint
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
END $$;
