-- Coarse company industry, derived at ingestion (src/industry.mjs): SmartRecruiters' native label
-- where present, otherwise inferred from the company name and role. Stored so it can back a filter;
-- ~39% of postings resolve and the rest stay NULL rather than being mis-bucketed.
ALTER TABLE jobs ADD COLUMN company_industry TEXT;
CREATE INDEX IF NOT EXISTS jobs_industry_active_idx ON jobs(company_industry, is_active, published_at DESC);
