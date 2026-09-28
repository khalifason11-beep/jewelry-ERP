CREATE TABLE "idempotency_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key" text NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idem_user_key_idx" ON "idempotency_keys" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "idem_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
-- ── CHECK constraints (generated from shared/src/db-checks.ts). Added NOT VALID: they apply to new
-- rows immediately and are validated against existing rows below, without rewriting any table.
ALTER TABLE "users" ADD CONSTRAINT "ck_users_status" CHECK (status IN ('ACTIVE', 'DISABLED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_status" CHECK (status IN ('ACTIVE', 'LOGGED_OUT', 'EXPIRED', 'REVOKED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_status" CHECK (status IN ('AVAILABLE', 'RESERVED', 'SOLD', 'REDEEMED', 'TRANSFERRED', 'DAMAGED', 'RETURNED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "ck_item_status_history_from_status" CHECK (from_status IS NULL OR from_status IN ('AVAILABLE', 'RESERVED', 'SOLD', 'REDEEMED', 'TRANSFERRED', 'DAMAGED', 'RETURNED', 'PURCHASED', 'RECEIVED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "ck_item_status_history_to_status" CHECK (to_status IN ('AVAILABLE', 'RESERVED', 'SOLD', 'REDEEMED', 'TRANSFERRED', 'DAMAGED', 'RETURNED', 'PURCHASED', 'RECEIVED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "ck_inventory_movements_type" CHECK (type IN ('PURCHASE', 'SALE', 'HASAD_REDEMPTION', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN', 'ADJUSTMENT', 'DAMAGE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_status" CHECK (status IN ('RECEIVED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_status" CHECK (status IN ('COMPLETED', 'VOIDED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET')) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "ck_expenses_status" CHECK (status IN ('APPROVED', 'PENDING', 'REJECTED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "ck_expenses_category" CHECK (category IN ('RENT', 'ELECTRICITY', 'TRANSPORTATION', 'SALARIES', 'MAINTENANCE', 'SECURITY', 'OTHER')) NOT VALID;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "ck_transfers_status" CHECK (status IN ('IN_TRANSIT', 'RECEIVED', 'CANCELLED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "ck_hasad_withdrawals_status" CHECK (status IN ('READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "ck_hasad_withdrawals_external_status" CHECK (external_status IN ('PENDING', 'READY_FOR_PICKUP', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_status" CHECK (status IN ('DRAFT', 'COMPLETED', 'ABORTED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_settlement_direction" CHECK (settlement_direction IS NULL OR settlement_direction IN ('BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH', 'NONE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_type" CHECK (type IN ('HASAD_WEIGHT_DIFFERENCE')) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_direction" CHECK (direction IN ('BRANCH_PAYS_CUSTOMER', 'CUSTOMER_PAYS_BRANCH')) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET')) NOT VALID;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "ck_branding_assets_kind" CHECK (kind IN ('LOGO')) NOT VALID;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "ck_branding_assets_mime" CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')) NOT VALID;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "ck_idempotency_keys_status" CHECK (status IN ('IN_PROGRESS', 'COMPLETED')) NOT VALID;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "ck_products_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "ck_hasad_withdrawals_entitlement_karat_range" CHECK (entitlement_karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemption_items" ADD CONSTRAINT "ck_hasad_redemption_items_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "gold_rates" ADD CONSTRAINT "ck_gold_rates_karat_range" CHECK (karat BETWEEN 1 AND 24) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_gross_weight_mg_nonneg" CHECK (gross_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_net_weight_mg_nonneg" CHECK (net_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_net_le_gross" CHECK (net_weight_mg <= gross_weight_mg) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "ck_inventory_movements_net_weight_mg_nonneg" CHECK (net_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_total_net_weight_mg_nonneg" CHECK (total_net_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_item_count_nonneg" CHECK (item_count >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_net_weight_mg_nonneg" CHECK (net_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "ck_hasad_withdrawals_entitled_weight_mg_nonneg" CHECK (entitled_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_entitled_weight_mg_nonneg" CHECK (entitled_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_delivered_weight_mg_nonneg" CHECK (delivered_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemption_items" ADD CONSTRAINT "ck_hasad_redemption_items_net_weight_mg_nonneg" CHECK (net_weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_weight_mg_nonneg" CHECK (weight_mg >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_purchase_cost_nonneg" CHECK (purchase_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_making_cost_nonneg" CHECK (making_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_other_cost_nonneg" CHECK (other_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_total_cost_nonneg" CHECK (total_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_selling_price_nonneg" CHECK (selling_price >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "ck_jewelry_items_total_cost_sum" CHECK (total_cost = purchase_cost + making_cost + other_cost) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "ck_inventory_movements_cost_value_nonneg" CHECK (cost_value >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "ck_inventory_movements_direction" CHECK (direction IN (-1, 1)) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "ck_purchases_total_cost_nonneg" CHECK (total_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "ck_purchase_items_purchase_cost_nonneg" CHECK (purchase_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "ck_purchase_items_making_cost_nonneg" CHECK (making_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "ck_purchase_items_other_cost_nonneg" CHECK (other_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_subtotal_nonneg" CHECK (subtotal >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_discount_total_nonneg" CHECK (discount_total >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_total_nonneg" CHECK (total >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_cost_total_nonneg" CHECK (cost_total >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_total_sum" CHECK (total = subtotal - discount_total) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_list_price_nonneg" CHECK (list_price >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_discount_nonneg" CHECK (discount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_final_price_nonneg" CHECK (final_price >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_unit_cost_nonneg" CHECK (unit_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "ck_sale_items_final_price_sum" CHECK (final_price = list_price - discount) NOT VALID;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "ck_expenses_amount_positive" CHECK (amount > 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_settlement_amount_nonneg" CHECK (settlement_amount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_items_cost_nonneg" CHECK (items_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "ck_hasad_redemptions_rate_per_gram_nonneg" CHECK (rate_per_gram IS NULL OR rate_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "hasad_redemption_items" ADD CONSTRAINT "ck_hasad_redemption_items_unit_cost_nonneg" CHECK (unit_cost >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_rate_per_gram_nonneg" CHECK (rate_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "ck_settlements_amount_nonneg" CHECK (amount >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "gold_rates" ADD CONSTRAINT "ck_gold_rates_price_per_gram_nonneg" CHECK (price_per_gram >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "ck_transfers_distinct_branches" CHECK (from_branch_id <> to_branch_id) NOT VALID;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_failed_login_count_nonneg" CHECK (failed_login_count >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "ck_branding_assets_size_nonneg" CHECK (size >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "ck_branding_assets_width_nonneg" CHECK (width >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "branding_assets" ADD CONSTRAINT "ck_branding_assets_height_nonneg" CHECK (height >= 0) NOT VALID;--> statement-breakpoint
-- Validate each constraint against existing rows. A constraint whose existing rows violate it is
-- left NOT VALID (still enforced for every new or changed row) and reported, instead of failing the
-- deploy or touching data; the server logs it at start-up (docs/decisions.md D-2a-2).
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
-- ── Append-only ledgers: UPDATE, DELETE and TRUNCATE are refused at the database level, like
-- settings_history (0003). Corrections are new rows, never edits.
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER inventory_movements_append_only BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER inventory_movements_no_truncate BEFORE TRUNCATE ON "inventory_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER item_status_history_append_only BEFORE UPDATE OR DELETE ON "item_status_history"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER item_status_history_no_truncate BEFORE TRUNCATE ON "item_status_history"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER gold_rates_append_only BEFORE UPDATE OR DELETE ON "gold_rates"
  FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER gold_rates_no_truncate BEFORE TRUNCATE ON "gold_rates"
  FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
-- ── Second layer on real PostgreSQL: the application role loses UPDATE/DELETE/TRUNCATE on the
-- append-only tables (a superuser, e.g. embedded PGlite or a local admin, is left alone: privileges
-- do not apply to it, the triggers above still do). If the app connects with a role other than the
-- one running migrations, grant that role only SELECT and INSERT on these tables (docs/DEPLOYMENT.md).
DO $$
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs", "inventory_movements", "item_status_history", "gold_rates", "settings_history" FROM PUBLIC;
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs", "inventory_movements", "item_status_history", "gold_rates", "settings_history" FROM %I', current_user);
  END IF;
END $$;
