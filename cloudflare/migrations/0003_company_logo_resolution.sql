-- Tracks when a board page was last scraped for a company logo so the extra HTML request happens
-- roughly monthly per board rather than on every refresh.
ALTER TABLE companies ADD COLUMN logo_checked_at TEXT;

CREATE INDEX IF NOT EXISTS companies_logo_checked_idx ON companies(logo_checked_at);
