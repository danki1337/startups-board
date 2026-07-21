-- Typeahead source for the role-title field. Querying DISTINCT titles from `jobs` on every keystroke
-- would scan ~511k rows each time; this aggregate holds ~99k rows (one per distinct title) and is
-- refreshed by the daily cron, so a suggestion lookup touches a fraction of the data.
CREATE TABLE IF NOT EXISTS job_titles (
  title TEXT PRIMARY KEY NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_titles_count_idx ON job_titles(job_count DESC);
