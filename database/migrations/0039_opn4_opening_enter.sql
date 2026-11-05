-- OPN-4 (D-opn4-1): the Branch Manager enters the pieces of the own branch's opening balance.
-- A new permission `opening.enter` (the draft piece lines: view, template, add, remove, CSV import, export), granted to
-- the Branch Manager and to the General Manager (who holds every permission). `opening.manage` stays General Manager
-- only and keeps starting an opening, the seal and the broken-scrap lines; its description says so now.
-- Additive and idempotent: no opening, line or stock row changes. Only the three system roles exist (no screen or API
-- creates a role or edits grants), so no other role gains anything.
INSERT INTO "permissions" ("code", "description") VALUES
  ('opening.enter', 'Enter the pieces of the opening balance of the own branch (draft only)')
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_code")
  SELECT r."id", 'opening.enter' FROM "roles" r WHERE r."code" IN ('BRANCH_MANAGER', 'GENERAL_MANAGER') ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "permissions" SET "description" = 'Start and seal the opening balance of a branch (once per branch); its broken scrap'
  WHERE "code" = 'opening.manage';
