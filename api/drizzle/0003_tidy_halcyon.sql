CREATE TABLE `company_intel` (
	`company_name` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`intel_json` text NOT NULL,
	`fetched_at` integer NOT NULL
);