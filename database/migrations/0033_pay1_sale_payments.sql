CREATE TABLE "sale_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"line_no" smallint NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"ref_invoice" text,
	"ref_transaction" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_payments_sale_line_uq" ON "sale_payments" USING btree ("sale_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_payments_sale_method_uq" ON "sale_payments" USING btree ("sale_id","method");--> statement-breakpoint
CREATE INDEX "sale_payments_method_ref_idx" ON "sale_payments" USING btree ("method","ref_transaction");--> statement-breakpoint
-- ── PAY-1 hand-written part (plan docs/plans/PAY-1.md §1, decisions D-pay1-1 to D-pay1-3). Additive: a new table, its
-- checks and append-only triggers; SPLIT added to the label of sales.payment_method. Nothing existing is changed. The
-- lines of existing sales are written by 0034; the rule "every sale has 1 or 2 lines summing to its total" by 0035.
ALTER TABLE "sale_payments" ADD CONSTRAINT "ck_sale_payments_method" CHECK (method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD'));--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "ck_sale_payments_line_no" CHECK (line_no IN (1, 2));--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "ck_sale_payments_amount_positive" CHECK (amount > 0);--> statement-breakpoint
-- The references of each method: HASAD its invoice number (and an optional transaction reference); BANK_TRANSFER its
-- bank reference (FIX-2 length); every other method none.
ALTER TABLE "sale_payments" ADD CONSTRAINT "ck_sale_payments_references" CHECK (
  (method = 'HASAD' AND ref_invoice IS NOT NULL AND btrim(ref_invoice) <> '')
  OR (method = 'BANK_TRANSFER' AND ref_invoice IS NULL AND ref_transaction IS NOT NULL AND length(btrim(ref_transaction)) BETWEEN 4 AND 40)
  OR (method NOT IN ('HASAD', 'BANK_TRANSFER') AND ref_invoice IS NULL AND ref_transaction IS NULL)
);--> statement-breakpoint
CREATE TRIGGER sale_payments_append_only BEFORE UPDATE OR DELETE ON "sale_payments" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER sale_payments_no_truncate BEFORE TRUNCATE ON "sale_payments" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('sale_payments');--> statement-breakpoint
-- allow-destructive: D-pay1-3 replace the sales payment-method CHECK to add the SPLIT label; every existing row stays valid (validated)
ALTER TABLE "sales" DROP CONSTRAINT "ck_sales_payment_method";--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "ck_sales_payment_method" CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'CARD', 'MOBILE_WALLET', 'HASAD', 'SPLIT'));
