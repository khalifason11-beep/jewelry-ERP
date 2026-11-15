-- LBL-2 (plan docs/plans/LBL-2.md §7, D-lbl2-1): the tightening step, after the additive 0042 and the backfill 0043.
-- Every opening line has a piece: either its piece already (item_id, a sealed opening's line) or the code reserved for
-- it (reserved_code, a draft line). Added NOT VALID, then validated: the validation stops the upgrade if a line breaks
-- the rule (none can after 0043, which gave every draft line its code). No row changes.
ALTER TABLE "opening_lines" ADD CONSTRAINT "ck_opening_lines_code_or_piece" CHECK (item_id IS NOT NULL OR reserved_code IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "opening_lines" VALIDATE CONSTRAINT "ck_opening_lines_code_or_piece";
