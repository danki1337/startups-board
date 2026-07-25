-- Two expression indexes for the last query paths that had none. Measured against production
-- before this migration, warm, two runs each:
--
--   ?sort=company              3.6s   ORDER BY lower(coalesce(company_name, company_identifier))
--   ?employmentType=Full-time  3.3s   WHERE lower(replace(employment_type, '-', ' ')) IN (…)
--
-- against 0.52s for ?city=Berlin and 0.55s for ?country=de,fr,gb, which are ordinary column
-- indexes. Both slow clauses are expressions over a column rather than the column itself, so no
-- existing index can serve them and each one sorts or scans all 1.24M active rows.
--
-- SQLite has indexed deterministic expressions since 3.9, and both of these are deterministic. The
-- expression text below is written to match the query text in web/app/jobs-query.ts character for
-- character (minus the `j.` alias, which the planner resolves to the same column); if either side
-- is reworded, the index silently stops being used and the path silently returns to 3s.
--
-- No backfill: an index builds itself from the rows already present.

-- The company sort. is_active leads because every query has it, then the sort key, then the
-- tiebreak -- so the ordering is satisfied by a covering walk instead of a sort.
CREATE INDEX IF NOT EXISTS jobs_company_sort_idx
  ON jobs(is_active, lower(coalesce(company_name, company_identifier)), key);

-- The Job type facet. Providers spell this every way there is ("Full-Time", "full time", "Full
-- Time"), which is why the filter normalises case and hyphens before comparing; the index has to
-- store the normalised form or it cannot answer the comparison. published_at DESC trails so the
-- default sort comes out of the same walk.
CREATE INDEX IF NOT EXISTS jobs_employment_active_idx
  ON jobs(lower(replace(employment_type, '-', ' ')), is_active, published_at DESC);
