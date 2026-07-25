-- How many CONSECUTIVE refreshes of this board have found nothing to write. It selects the rung on
-- the active-refresh ladder in cloudflare/src/config.mjs: a board that just changed is looked at
-- again in 3 hours, one that has come back empty five times running in 48.
--
-- Why, measured on this database: over 24 hours, 89,109 of 128,690 completed refreshes -- 69.2% --
-- changed not one row. And the waste is stratified rather than random. Across 3 days, at roughly 6
-- refreshes per board:
--
--     changed on 0 of them   13,326 boards      <- pure waste at a flat 12h
--     changed on 1           9,790
--     changed on 2           7,922
--     changed on 3           6,998
--     changed on 4           3,609
--     changed on 5           2,015
--     changed on 6-9         ~1,980 boards      <- changes on essentially every look
--
-- Quiet is a property of the board, not noise, so spending the crawl budget where the churn is
-- actually works: the same ~92,000 refreshes a day, but the boards that post get 8 of them instead
-- of 2 and the dormant third gets one every other day.
--
-- Defaults to 0, which is the FAST rung. That is the deliberate direction to be wrong in: every
-- existing board gets one eager look, and the ones with nothing to show settle down by themselves
-- within a day or two. Starting them all slow would have hidden real postings until each board
-- happened to change.
ALTER TABLE boards ADD COLUMN quiet_syncs INTEGER NOT NULL DEFAULT 0;

-- enqueueDueBoards orders by next_sync_at over the whole table on every cron, so the ladder makes
-- that ordering matter far more than it did when every active board shared one interval.
CREATE INDEX IF NOT EXISTS boards_quiet_idx ON boards(status, quiet_syncs);
