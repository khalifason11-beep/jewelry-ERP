ALTER TABLE "sales" ADD COLUMN "original_printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "reprint_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- ── Invoice printing (D-print-5). Additive only: a nullable timestamp and a counter defaulting to 0;
-- existing sales keep original_printed_at NULL (no print was recorded for them) and 0 reprints.
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_reprint_count_nonneg" CHECK (reprint_count >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "sales" VALIDATE CONSTRAINT "ck_sales_reprint_count_nonneg";
