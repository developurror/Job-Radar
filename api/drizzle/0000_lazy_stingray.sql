CREATE TABLE `ingestion_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `job_duplicates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`canonical_job_id` integer NOT NULL,
	`similarity` real NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_embeddings` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`vector_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`company_name` text,
	`description_raw` text,
	`description_clean` text,
	`url` text,
	`posted_at` integer,
	`location_raw` text,
	`remote_claim` text,
	`employment_type` text,
	`salary_min` real,
	`salary_max` real,
	`salary_currency` text,
	`fingerprint` text NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_external_id` ON `jobs` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `jobs_fingerprint` ON `jobs` (`fingerprint`);