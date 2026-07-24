-- pruneSyncRuns deletes by age, but the only indexes on sync_runs lead with board_key or provider,
-- so each prune pass scanned the table to accumulate its 5,000 rows. At steady state that is
-- millions of rows read per day to delete a hundred thousand.
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs(started_at);

-- reconcileStuckSyncRuns closes rows abandoned mid-write; it selects on (status, started_at).
CREATE INDEX IF NOT EXISTS sync_runs_status_started_idx ON sync_runs(status, started_at);
