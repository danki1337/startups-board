-- The Company dropdown shows each company's logo beside its name, the same mark the table draws.
-- Carried on the aggregate rather than joined at query time: job_companies is keyed on the DISPLAY
-- name (one row per company), while companies is keyed per BOARD, so the join is many-to-one and
-- would need a GROUP BY on every keystroke -- which is the cost this table exists to avoid.
ALTER TABLE job_companies ADD COLUMN logo_url TEXT;
