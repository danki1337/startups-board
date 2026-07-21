CREATE TABLE `companies` (
	`key` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`logo_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discovery_pages` (
	`key` text PRIMARY KEY NOT NULL,
	`index_id` text NOT NULL,
	`provider` text NOT NULL,
	`pattern` text NOT NULL,
	`page` integer NOT NULL,
	`total_pages` integer NOT NULL,
	`url_count` integer DEFAULT 0 NOT NULL,
	`processed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `discovery_pages_target_idx` ON `discovery_pages` (`index_id`,`provider`,`pattern`);--> statement-breakpoint
CREATE TABLE `failed_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`provider` text,
	`board_key` text,
	`payload` text NOT NULL,
	`error` text NOT NULL,
	`attempts` integer NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `provider_health` (
	`provider` text PRIMARY KEY NOT NULL,
	`successful_runs` integer DEFAULT 0 NOT NULL,
	`failed_runs` integer DEFAULT 0 NOT NULL,
	`active_jobs` integer DEFAULT 0 NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`last_error` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`board_key` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`job_count` integer DEFAULT 0 NOT NULL,
	`changed_jobs` integer DEFAULT 0 NOT NULL,
	`closed_jobs` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_board_idx` ON `sync_runs` (`board_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_provider_idx` ON `sync_runs` (`provider`,`started_at`);--> statement-breakpoint
CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
DROP INDEX `jobs_active_published_idx`;--> statement-breakpoint
DROP INDEX `jobs_provider_active_idx`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `company_name` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `seen_run_id` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
CREATE INDEX `jobs_workplace_active_idx` ON `jobs` (`workplace`,`is_active`,`published_at`);--> statement-breakpoint
CREATE INDEX `jobs_category_active_idx` ON `jobs` (`category`,`is_active`,`published_at`);--> statement-breakpoint
CREATE INDEX `jobs_active_published_idx` ON `jobs` (`is_active`,`published_at`,`key`);--> statement-breakpoint
CREATE INDEX `jobs_provider_active_idx` ON `jobs` (`provider`,`is_active`,`published_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_boards` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`identifier` text NOT NULL,
	`region` text DEFAULT 'global' NOT NULL,
	`board_url` text NOT NULL,
	`api_url` text NOT NULL,
	`company_key` text,
	`status` text DEFAULT 'new' NOT NULL,
	`queue_state` text DEFAULT 'idle' NOT NULL,
	`job_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_synced_at` text,
	`next_sync_at` text NOT NULL,
	`last_error` text,
	`discovered_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_boards`(
  "key", "provider", "identifier", "region", "board_url", "api_url", "company_key",
  "status", "queue_state", "job_count", "failure_count", "last_synced_at",
  "next_sync_at", "last_error", "discovered_at", "updated_at"
) SELECT
  "key", "provider", "identifier", 'global', '', '', NULL,
  "status", 'idle', "job_count", 0, "last_synced_at",
  COALESCE("last_synced_at", datetime('now')), "error",
  COALESCE("last_synced_at", datetime('now')), COALESCE("last_synced_at", datetime('now'))
FROM `boards`;--> statement-breakpoint
DROP TABLE `boards`;--> statement-breakpoint
ALTER TABLE `__new_boards` RENAME TO `boards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `boards_due_idx` ON `boards` (`queue_state`,`next_sync_at`);--> statement-breakpoint
CREATE INDEX `boards_provider_status_idx` ON `boards` (`provider`,`status`);--> statement-breakpoint
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(
  title, company_identifier, company_name, location,
  content='jobs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO jobs_fts(rowid, title, company_identifier, company_name, location)
SELECT rowid, title, company_identifier, company_name, location FROM jobs;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_insert` AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company_identifier, company_name, location)
  VALUES (new.rowid, new.title, new.company_identifier, new.company_name, new.location);
END;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_delete` AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_identifier, company_name, location)
  VALUES ('delete', old.rowid, old.title, old.company_identifier, old.company_name, old.location);
END;--> statement-breakpoint
CREATE TRIGGER `jobs_fts_update` AFTER UPDATE OF title, company_identifier, company_name, location ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company_identifier, company_name, location)
  VALUES ('delete', old.rowid, old.title, old.company_identifier, old.company_name, old.location);
  INSERT INTO jobs_fts(rowid, title, company_identifier, company_name, location)
  VALUES (new.rowid, new.title, new.company_identifier, new.company_name, new.location);
END;
