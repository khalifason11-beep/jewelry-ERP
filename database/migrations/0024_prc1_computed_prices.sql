-- PRC-1 (docs/plans/PRC-1.md): computed selling prices. Additive only; no existing row is changed.
-- D-prc1-2: the used-piece selling rate is a second KIND of selling rate in the same append-only history. Every row
-- written before PRC-1 was the selling rate of all pieces and becomes NEW. ADD COLUMN with a constant default rewrites
-- no row and fires no row trigger (the append-only triggers and REVOKE stay as they are).
ALTER TABLE "gold_rates" ADD COLUMN "kind" text DEFAULT 'NEW' NOT NULL;--> statement-breakpoint
CREATE INDEX "gold_rates_karat_kind_idx" ON "gold_rates" USING btree ("karat","kind","effective_at");--> statement-breakpoint
-- Validated at once: every existing row holds the default.
ALTER TABLE "gold_rates" ADD CONSTRAINT "ck_gold_rates_kind" CHECK (kind IN ('NEW', 'USED'));--> statement-breakpoint
-- D-prc1-6: the cashier may buy a SELLABLE piece from a customer (the price is no longer typed). A new permission so
-- `scrap.buy` keeps its meaning (both kinds: branch manager and General Manager); every role holds the new one.
INSERT INTO "permissions" ("code", "description") VALUES
  ('scrap.buy_sellable', 'Buy a sellable piece from a customer at the counter (not broken scrap)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'scrap.buy_sellable' FROM "roles" r WHERE r."code" IN ('GENERAL_MANAGER', 'BRANCH_MANAGER', 'CASHIER')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
-- D-prc1-3: an installation that already holds pieces keeps today's tag prices (FIXED_TAG) until the General Manager
-- sets the rates and switches on the Prices screen; switching silently would reprice every piece. A new installation
-- (no piece yet) keeps the default RATE_COMPUTED. Written only when the setting has never been set.
INSERT INTO "settings" ("key", "value", "version", "updated_at", "updated_by")
  SELECT 'pricing.mode', '"FIXED_TAG"'::jsonb, 1, now(), NULL
  WHERE EXISTS (SELECT 1 FROM "jewelry_items") AND NOT EXISTS (SELECT 1 FROM "settings" WHERE "key" = 'pricing.mode');--> statement-breakpoint
INSERT INTO "settings_history" ("key", "old_value", "new_value", "version", "actor_id", "actor_username", "reason", "at")
  SELECT 'pricing.mode', NULL, '"FIXED_TAG"'::jsonb, 1, NULL, 'system:migration-0024', 'PRC-1: an existing installation keeps its tag prices until the General Manager switches', now()
  WHERE EXISTS (SELECT 1 FROM "settings" s WHERE s."key" = 'pricing.mode' AND s."updated_by" IS NULL AND s."version" = 1)
    AND NOT EXISTS (SELECT 1 FROM "settings_history" WHERE "key" = 'pricing.mode');
