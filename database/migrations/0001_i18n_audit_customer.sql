ALTER TABLE "audit_logs" ADD COLUMN "description_key" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "description_params" jsonb;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "customer_name_ar" text;