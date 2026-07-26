-- The company FILTER expression, indexed.
--
-- jobs_company_sort_idx already indexes lower(coalesce(company_name, company_identifier)) -- which
-- is what ORDER BY company sorts on, and is NOT what the ?company= filter compares against. The
-- filter uses companyMatchExpression(): the same display expression, plus the Workday
-- "tenant|wdN|site" split, the iCIMS prefix strip, and the separator normalisation.
--
-- SQLite matches an expression index by comparing the expression TEXT character for character. The
-- two differ, so the filter has never had an index to use, and every company-filtered page has been
-- a per-row evaluation over whatever the FTS subquery handed it. Measured against production, a
-- page-2 fetch costs 0.46-0.54s unfiltered against 0.70-6.26s with ?company= -- which is what makes
-- scrolling a filtered list stall: Virtuoso asks for the next page 1,400px early and does not get
-- it back in time, so the reader arrives at an empty edge and waits.
--
-- The expression below is GENERATED from companyMatchExpression("") rather than retyped, for the
-- one reason that matters here: an index whose text drifts from the query's by a single space is
-- silently ignored -- no error, no plan change, nothing to notice.
CREATE INDEX IF NOT EXISTS jobs_company_filter_idx
  ON jobs(trim(lower(replace(replace(replace(coalesce(nullif(company_name, ''), CASE
    WHEN instr(company_identifier, '|') > 0
      THEN substr(company_identifier, 1, instr(company_identifier, '|') - 1)
    WHEN provider = 'icims' AND lower(substr(company_identifier, 1, 8)) IN ('careers-', 'careers.')
      THEN substr(company_identifier, 9)
    WHEN provider = 'icims' AND lower(substr(company_identifier, 1, 5)) IN ('jobs-', 'jobs.')
      THEN substr(company_identifier, 6)
    ELSE company_identifier
  END), '-', ' '), '_', ' '), '.', ' '))), is_active, published_at DESC);
