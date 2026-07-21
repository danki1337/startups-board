CREATE TABLE IF NOT EXISTS companies (
  key TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  logo_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  key TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  identifier TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'global',
  board_url TEXT NOT NULL,
  api_url TEXT NOT NULL,
  company_key TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  queue_state TEXT NOT NULL DEFAULT 'idle',
  job_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  next_sync_at TEXT NOT NULL,
  last_error TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS boards_due_idx ON boards(queue_state, next_sync_at);
CREATE INDEX IF NOT EXISTS boards_provider_status_idx ON boards(provider, status);

CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  board_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  company_identifier TEXT NOT NULL,
  company_name TEXT,
  title TEXT NOT NULL,
  location TEXT,
  workplace TEXT NOT NULL DEFAULT 'Unspecified',
  employment_type TEXT,
  category TEXT NOT NULL DEFAULT 'Other',
  published_at TEXT,
  url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  seen_run_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS jobs_active_published_idx ON jobs(is_active, published_at DESC, key);
CREATE INDEX IF NOT EXISTS jobs_provider_active_idx ON jobs(provider, is_active, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_board_active_idx ON jobs(board_key, is_active);
CREATE INDEX IF NOT EXISTS jobs_workplace_active_idx ON jobs(workplace, is_active, published_at DESC);
CREATE INDEX IF NOT EXISTS jobs_category_active_idx ON jobs(category, is_active, published_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title,
  company_identifier,
  company_name,
  location,
  content='jobs',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS jobs_fts_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company_identifier, company_name, location)
  VALUES (new.rowid, new.title, new.company_identifier, new.company_name, new.location);
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_delete AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_identifier, company_name, location)
  VALUES ('delete', old.rowid, old.title, old.company_identifier, old.company_name, old.location);
END;

CREATE TRIGGER IF NOT EXISTS jobs_fts_update AFTER UPDATE OF title, company_identifier, company_name, location ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_identifier, company_name, location)
  VALUES ('delete', old.rowid, old.title, old.company_identifier, old.company_name, old.location);
  INSERT INTO jobs_fts(rowid, title, company_identifier, company_name, location)
  VALUES (new.rowid, new.title, new.company_identifier, new.company_name, new.location);
END;

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  board_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  job_count INTEGER NOT NULL DEFAULT 0,
  changed_jobs INTEGER NOT NULL DEFAULT 0,
  closed_jobs INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS sync_runs_board_idx ON sync_runs(board_key, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_provider_idx ON sync_runs(provider, started_at DESC);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY NOT NULL,
  successful_runs INTEGER NOT NULL DEFAULT 0,
  failed_runs INTEGER NOT NULL DEFAULT 0,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_pages (
  key TEXT PRIMARY KEY NOT NULL,
  index_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  pattern TEXT NOT NULL,
  page INTEGER NOT NULL,
  total_pages INTEGER NOT NULL,
  url_count INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_pages_target_idx ON discovery_pages(index_id, provider, pattern);

CREATE TABLE IF NOT EXISTS failed_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  task_type TEXT NOT NULL,
  provider TEXT,
  board_key TEXT,
  payload TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
