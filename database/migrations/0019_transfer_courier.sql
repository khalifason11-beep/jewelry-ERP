-- ── FIX-1 (docs/plans/POS-FIXES.md §2, docs/decisions.md D-fix-1): the courier's name on a transfer (SPEC §8).
-- Additive only: a nullable column (transfers sent before FIX-1 have none) and a CHECK on the new column, valid for
-- every row because every existing row is NULL. New transfers are refused without a courier by the server.
ALTER TABLE "transfers" ADD COLUMN "courier_name" text;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "ck_transfers_courier_name" CHECK (courier_name IS NULL OR length(btrim(courier_name)) BETWEEN 2 AND 80);
