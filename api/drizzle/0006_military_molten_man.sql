CREATE TABLE `bot_session_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`outcome` text NOT NULL,
	`combined_score` real,
	`chance_score` real,
	`quality_score` real,
	`rank` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `bot_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_session_results_session_job` ON `bot_session_results` (`session_id`,`job_id`);--> statement-breakpoint
CREATE INDEX `bot_session_results_session_rank` ON `bot_session_results` (`session_id`,`rank`);--> statement-breakpoint
CREATE TABLE `bot_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_user_id` text NOT NULL,
	`status` text NOT NULL,
	`state_json` text NOT NULL,
	`criteria_json` text NOT NULL,
	`profile_json` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bot_user_profiles` (
	`discord_user_id` text PRIMARY KEY NOT NULL,
	`search_json` text NOT NULL,
	`filters_json` text NOT NULL,
	`locale` text,
	`updated_at` integer NOT NULL
);
