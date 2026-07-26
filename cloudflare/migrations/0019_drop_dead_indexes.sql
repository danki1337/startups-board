-- Seven indexes no query can use, audited against every SQL statement in web/app, web/app/api and
-- cloudflare/src. Each one costs a row-write on every INSERT/UPDATE of its table -- and jobs and
-- sync_runs are the two hottest write paths in the system (a jobs row write currently fans out to
-- ~15 billed rows; sync_runs to 6). Dropping these is a permanent ~25% discount on sync_runs
-- writes and one row per jobs write, for indexes that served nothing.

-- ?category= is emitted by no UI surface (FILTER_PARAM_KEYS never included it) and the server-side
-- param has been removed with it.
DROP INDEX IF EXISTS jobs_category_active_idx;
-- Cited reconcileStuckSyncRuns as its consumer; that function no longer exists (sync_runs is
-- written once, with its final status). Nothing selects sync_runs by status.
DROP INDEX IF EXISTS sync_runs_status_started_idx;
-- The production worker only INSERTs sync_runs and deletes by age (sync_runs_started_idx, kept).
-- Nothing reads by board or provider.
DROP INDEX IF EXISTS sync_runs_board_idx;
DROP INDEX IF EXISTS sync_runs_provider_idx;
-- Both readers of logo_checked_at look the row up by key and read the column as output.
DROP INDEX IF EXISTS companies_logo_checked_idx;
-- scheduleDueBoards filters provider in JS; enqueueDueBoards drives (queue_state, next_sync_at).
DROP INDEX IF EXISTS boards_provider_status_idx;
-- Its own justification comment described a (queue_state, next_sync_at) index; what was created
-- was (status, quiet_syncs), which no statement has ever been able to use.
DROP INDEX IF EXISTS boards_quiet_idx;

-- And the one index that was genuinely missing: the daily archive sweep's predicate. Without it,
-- each of the sweep's passes seeks is_active = 0 through jobs_active_published_idx, reads every
-- inactive row in published_at order, and sorts them all by closed_at -- the same shape 0010 fixed
-- for sync_runs and 0018 for failed_tasks, on the table where it costs the most. Partial, because
-- only closed rows are ever asked for by closed_at, and active rows would double the write cost of
-- every close/reopen for entries nothing reads.
CREATE INDEX IF NOT EXISTS jobs_closed_idx ON jobs(closed_at) WHERE is_active = 0;
