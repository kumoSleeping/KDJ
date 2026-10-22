-- The list shows each report's description and commonest real error without opening it.
-- Rows received before this are filled in by the Worker the first time the list reaches them.
ALTER TABLE reports ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN top_error TEXT NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0;
