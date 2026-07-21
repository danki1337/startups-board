-- City and role family resolved at ingestion (src/locations.mjs, src/roles.mjs) so both can back a
-- dropdown. Neither can be derived at query time: there are ~19,600 distinct location strings and
-- ~99,000 distinct titles, and the 200 most common titles cover only 11% of postings.
ALTER TABLE jobs ADD COLUMN city TEXT;
ALTER TABLE jobs ADD COLUMN role_family TEXT;

CREATE INDEX IF NOT EXISTS jobs_city_active_idx ON jobs(city, is_active, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_role_active_idx ON jobs(role_family, is_active, published_at DESC);
