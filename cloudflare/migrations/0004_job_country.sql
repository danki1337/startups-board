-- Country resolved from the free-text location at ingestion (src/locations.mjs). Storing it avoids
-- re-deriving a country from ~19,600 distinct location strings on every query, and is what makes a
-- country filter viable at half a million rows. NULL means "unresolved", not "no country".
ALTER TABLE jobs ADD COLUMN country TEXT;

CREATE INDEX IF NOT EXISTS jobs_country_active_idx ON jobs(country, is_active, published_at DESC);
