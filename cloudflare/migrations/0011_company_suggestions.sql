-- Options source for the Company filter dropdown, and the exact twin of job_titles (0006).
--
-- Grouping `jobs` by company on every keystroke would scan all ~1.24M active rows. This aggregate
-- holds one row per distinct company (~33.6k) and is rebuilt by the same daily cron, so a lookup
-- touches a thousandth of the data and the count beside each name is exact rather than estimated
-- from a read window.
--
-- The key is the DISPLAY name, because that is what the filter matches on: `company` is compared
-- against company_name/company_identifier with a substring LIKE, so the value the dropdown offers
-- has to be the value the filter can find.
CREATE TABLE IF NOT EXISTS job_companies (
  company TEXT PRIMARY KEY NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS job_companies_count_idx ON job_companies(job_count DESC);
