-- Spell-correction dictionary for search. fts5vocab exposes the jobs_fts term list with per-term
-- document counts, so "did you mean" can rank edit-distance-1 alternatives by how common they are in
-- the index -- no separate vocabulary table to build or keep in sync. It is a lightweight view over
-- the existing FTS index, not a data copy.
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_vocab USING fts5vocab('jobs_fts', 'row');
