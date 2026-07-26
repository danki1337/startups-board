-- failed_tasks had no index at all beyond its primary key, and two hot paths scanned the whole
-- table for every probe.
--
-- The recovery probe -- UPDATE failed_tasks SET resolved_at = ? WHERE board_key = ? AND
-- resolved_at IS NULL -- runs on EVERY successful refresh (~61,000/day) and each one read ~1,600
-- rows: 99M rows read a day to almost always resolve nothing. Partial on open rows, because the
-- probe only ever touches unresolved rows and resolved ones would just bloat it.
CREATE INDEX IF NOT EXISTS failed_tasks_open_board_idx
  ON failed_tasks(board_key) WHERE resolved_at IS NULL;

-- pruneFailedTasks deletes resolved rows by age in passes of 5,000; without this each pass scans
-- everything resolved to find its batch, the same shape migration 0010 fixed for sync_runs.
CREATE INDEX IF NOT EXISTS failed_tasks_resolved_idx
  ON failed_tasks(resolved_at) WHERE resolved_at IS NOT NULL;
