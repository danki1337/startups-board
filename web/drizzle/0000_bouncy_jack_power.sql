CREATE TABLE `boards` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`identifier` text NOT NULL,
	`status` text NOT NULL,
	`job_count` integer DEFAULT 0 NOT NULL,
	`last_synced_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`key` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`board_key` text NOT NULL,
	`provider` text NOT NULL,
	`company_identifier` text NOT NULL,
	`title` text NOT NULL,
	`location` text,
	`workplace` text DEFAULT 'Unspecified' NOT NULL,
	`employment_type` text,
	`category` text DEFAULT 'Other' NOT NULL,
	`published_at` text,
	`url` text NOT NULL,
	`fingerprint` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `jobs_active_published_idx` ON `jobs` (`is_active`,`published_at`);--> statement-breakpoint
CREATE INDEX `jobs_provider_active_idx` ON `jobs` (`provider`,`is_active`);--> statement-breakpoint
CREATE INDEX `jobs_board_active_idx` ON `jobs` (`board_key`,`is_active`);