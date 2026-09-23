CREATE SCHEMA "hasad_mock";
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"username" text,
	"user_full_name" text,
	"role" text,
	"branch_id" integer,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"session_id" text,
	"ip_address" text
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"city" text NOT NULL,
	"address" text,
	"phone" text,
	"hasad_branch_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_code_unique" UNIQUE("code"),
	CONSTRAINT "branches_hasad_branch_code_unique" UNIQUE("hasad_branch_code")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	CONSTRAINT "categories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"scope" text NOT NULL,
	"next" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"expense_date" date NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	CONSTRAINT "expenses_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "gold_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"karat" smallint NOT NULL,
	"price_per_gram" bigint NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"set_by" integer
);
--> statement-breakpoint
CREATE TABLE "hasad_redemption_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"redemption_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"karat" smallint NOT NULL,
	"unit_cost" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hasad_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"withdrawal_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"cashier_id" integer NOT NULL,
	"status" text NOT NULL,
	"entitled_weight_mg" integer NOT NULL,
	"delivered_weight_mg" integer DEFAULT 0 NOT NULL,
	"difference_mg" integer DEFAULT 0 NOT NULL,
	"settlement_direction" text,
	"settlement_amount" bigint DEFAULT 0 NOT NULL,
	"rate_per_gram" bigint,
	"items_cost" bigint DEFAULT 0 NOT NULL,
	"customer_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"abort_reason" text,
	CONSTRAINT "hasad_redemptions_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "hasad_withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"hasad_customer_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_name_ar" text,
	"customer_phone" text,
	"customer_national_id_masked" text,
	"entitled_weight_mg" integer NOT NULL,
	"entitlement_karat" smallint NOT NULL,
	"branch_id" integer NOT NULL,
	"status" text NOT NULL,
	"external_status" text NOT NULL,
	"pickup_code" text,
	"requested_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"opened_by" integer,
	"completed_at" timestamp with time zone,
	"completed_by" integer,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" integer,
	"cancel_reason" text,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hasad_withdrawals_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"type" text NOT NULL,
	"direction" smallint NOT NULL,
	"from_branch_id" integer,
	"to_branch_id" integer,
	"ref_type" text,
	"ref_id" integer,
	"ref_number" text,
	"net_weight_mg" integer NOT NULL,
	"cost_value" bigint NOT NULL,
	"user_id" integer,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_status_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"branch_id" integer NOT NULL,
	"ref_type" text,
	"ref_id" integer,
	"ref_number" text,
	"user_id" integer,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jewelry_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"barcode" text NOT NULL,
	"product_id" integer NOT NULL,
	"karat" smallint NOT NULL,
	"gross_weight_mg" integer NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"purchase_cost" bigint NOT NULL,
	"making_cost" bigint DEFAULT 0 NOT NULL,
	"other_cost" bigint DEFAULT 0 NOT NULL,
	"total_cost" bigint NOT NULL,
	"selling_price" bigint NOT NULL,
	"branch_id" integer NOT NULL,
	"status" text NOT NULL,
	"purchase_id" integer,
	"reservation_ref" text,
	"reserved_at" timestamp with time zone,
	"reserved_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jewelry_items_code_unique" UNIQUE("code"),
	CONSTRAINT "jewelry_items_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"category_id" integer NOT NULL,
	"karat" smallint NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"purchase_cost" bigint NOT NULL,
	"making_cost" bigint NOT NULL,
	"other_cost" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"supplier_id" integer,
	"supplier_invoice_no" text,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"item_count" integer NOT NULL,
	"total_net_weight_mg" integer NOT NULL,
	"total_cost" bigint NOT NULL,
	"notes" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" integer NOT NULL,
	"permission_code" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_code_pk" PRIMARY KEY("role_id","permission_code")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"rank" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"product_name" text NOT NULL,
	"karat" smallint NOT NULL,
	"net_weight_mg" integer NOT NULL,
	"list_price" bigint NOT NULL,
	"discount" bigint DEFAULT 0 NOT NULL,
	"final_price" bigint NOT NULL,
	"unit_cost" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"branch_id" integer NOT NULL,
	"cashier_id" integer NOT NULL,
	"session_id" text,
	"customer_name" text,
	"customer_phone" text,
	"subtotal" bigint NOT NULL,
	"discount_total" bigint DEFAULT 0 NOT NULL,
	"total" bigint NOT NULL,
	"cost_total" bigint NOT NULL,
	"payment_method" text NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" integer,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"branch_id" integer,
	"login_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"device" text,
	"ip_address" text,
	"current_module" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"is_simulated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"redemption_id" integer,
	"branch_id" integer NOT NULL,
	"direction" text NOT NULL,
	"weight_mg" integer NOT NULL,
	"rate_per_gram" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"payment_method" text NOT NULL,
	"confirmed_by" integer NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"phone" text
);
--> statement-breakpoint
CREATE TABLE "transfer_items" (
	"transfer_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	CONSTRAINT "transfer_items_transfer_id_item_id_pk" PRIMARY KEY("transfer_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"from_branch_id" integer NOT NULL,
	"to_branch_id" integer NOT NULL,
	"status" text NOT NULL,
	"notes" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" integer,
	"received_at" timestamp with time zone,
	CONSTRAINT "transfers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"full_name" text NOT NULL,
	"full_name_ar" text,
	"role_id" integer NOT NULL,
	"branch_id" integer,
	"password_hash" text NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp with time zone,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"phone" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "hasad_mock"."api_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"operation" text NOT NULL,
	"request" jsonb,
	"response_status" integer NOT NULL,
	"response" jsonb,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hasad_mock"."customers" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"full_name_ar" text,
	"phone" text,
	"national_id_masked" text,
	"balance_mg" integer NOT NULL,
	"karat" smallint DEFAULT 21 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hasad_mock"."withdrawals" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"weight_mg" integer NOT NULL,
	"karat" smallint NOT NULL,
	"branch_code" text NOT NULL,
	"status" text NOT NULL,
	"pickup_code" text,
	"requested_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completion" jsonb,
	"cancellation" jsonb
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_redemption_items" ADD CONSTRAINT "hasad_redemption_items_redemption_id_hasad_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."hasad_redemptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_redemption_items" ADD CONSTRAINT "hasad_redemption_items_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "hasad_redemptions_withdrawal_id_hasad_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."hasad_withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "hasad_redemptions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_redemptions" ADD CONSTRAINT "hasad_redemptions_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "hasad_withdrawals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "hasad_withdrawals_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "hasad_withdrawals_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_withdrawals" ADD CONSTRAINT "hasad_withdrawals_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "jewelry_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewelry_items" ADD CONSTRAINT "jewelry_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_code_permissions_code_fk" FOREIGN KEY ("permission_code") REFERENCES "public"."permissions"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_id_users_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_redemption_id_hasad_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."hasad_redemptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_transfer_id_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_items" ADD CONSTRAINT "transfer_items_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_branch_id_branches_id_fk" FOREIGN KEY ("from_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_branch_id_branches_id_fk" FOREIGN KEY ("to_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hasad_mock"."withdrawals" ADD CONSTRAINT "withdrawals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "hasad_mock"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_branch_idx" ON "audit_logs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_seq_scope_idx" ON "document_sequences" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "exp_branch_date_idx" ON "expenses" USING btree ("branch_id","expense_date");--> statement-breakpoint
CREATE INDEX "gold_rates_karat_idx" ON "gold_rates" USING btree ("karat","effective_at");--> statement-breakpoint
CREATE INDEX "hri_redemption_idx" ON "hasad_redemption_items" USING btree ("redemption_id");--> statement-breakpoint
CREATE INDEX "hw_branch_status_idx" ON "hasad_withdrawals" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "mov_branch_at_idx" ON "inventory_movements" USING btree ("branch_id","at");--> statement-breakpoint
CREATE INDEX "mov_item_idx" ON "inventory_movements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "ish_item_idx" ON "item_status_history" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "items_branch_status_idx" ON "jewelry_items" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "items_product_idx" ON "jewelry_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sales_branch_at_idx" ON "sales" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "sessions" USING btree ("status");