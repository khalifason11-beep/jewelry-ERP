CREATE TABLE "label_prints" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"copies" smallint NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"batch_id" text NOT NULL,
	"printed_by" integer NOT NULL,
	"session_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_item_id_jewelry_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."jewelry_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "label_prints_printed_by_users_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_prints_item_idx" ON "label_prints" USING btree ("item_id","id");--> statement-breakpoint
CREATE INDEX "label_prints_branch_at_idx" ON "label_prints" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "label_prints_first_uq" ON "label_prints" USING btree ("item_id") WHERE kind = 'FIRST';--> statement-breakpoint
-- ── LBL-1 hand-written part (plan docs/plans/LBL-1.md, D-lbl1-3): every piece label printed, append-only. Additive.
ALTER TABLE "label_prints" ADD CONSTRAINT "ck_label_prints_kind" CHECK (kind IN ('FIRST', 'REPRINT'));--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "ck_label_prints_source" CHECK (source IN ('PIECE', 'STOCK_LIST', 'PURCHASE', 'OPENING'));--> statement-breakpoint
ALTER TABLE "label_prints" ADD CONSTRAINT "ck_label_prints_copies" CHECK (copies BETWEEN 1 AND 20);--> statement-breakpoint
-- A print row is of the piece's branch at the print; FIRST only for a piece never printed, REPRINT only after one.
CREATE OR REPLACE FUNCTION jerp_label_print_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jewelry_items i WHERE i.id = NEW.item_id AND i.branch_id = NEW.branch_id) THEN
    RAISE EXCEPTION 'label_prints: piece % is not in branch %', NEW.item_id, NEW.branch_id;
  END IF;
  SELECT count(*) INTO before_n FROM label_prints WHERE item_id = NEW.item_id;
  IF (NEW.kind = 'FIRST') <> (before_n = 0) THEN
    RAISE EXCEPTION 'label_prints: piece % has % earlier print(s); this one cannot be %', NEW.item_id, before_n, NEW.kind;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER label_prints_check BEFORE INSERT ON "label_prints" FOR EACH ROW EXECUTE FUNCTION jerp_label_print_check();--> statement-breakpoint
-- Append-only: a label printed is never unrecorded, edited or deleted.
CREATE TRIGGER label_prints_append_only BEFORE UPDATE OR DELETE ON "label_prints" FOR EACH ROW EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
CREATE TRIGGER label_prints_no_truncate BEFORE TRUNCATE ON "label_prints" FOR EACH STATEMENT EXECUTE FUNCTION jerp_forbid_modification();--> statement-breakpoint
SELECT jerp_lock_append_only('label_prints');
