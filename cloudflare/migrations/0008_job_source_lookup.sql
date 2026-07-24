-- Cross-provider dedup. A Getro board re-lists jobs hosted on the company's own ATS board; at
-- ingestion we suppress the Getro copy when the native (provider, source_id) posting already
-- exists. Without this index that probe is a full scan of every jobs row on each Getro refresh.
-- is_active trails the seek columns so the common probe (SELECT source_id ... WHERE provider = ?
-- AND source_id IN (...) AND is_active = 1) is served entirely from the index.
CREATE INDEX IF NOT EXISTS jobs_provider_source_idx ON jobs(provider, source_id, is_active);
