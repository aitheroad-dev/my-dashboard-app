-- 0006_cards_fields.sql — richer cards: due date, priority, labels, checklist.
-- Additive + backward-compatible: existing cards get NULL due_date + safe defaults.
-- One ALTER per statement (migrate.ts splits on ';'); name-tracked so it runs once.
-- labels/checklist are JSON TEXT (arrays); priority is a small enum with a 'none' default.

ALTER TABLE cards ADD COLUMN due_date TEXT;
ALTER TABLE cards ADD COLUMN priority TEXT NOT NULL DEFAULT 'none';
ALTER TABLE cards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cards ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]';
