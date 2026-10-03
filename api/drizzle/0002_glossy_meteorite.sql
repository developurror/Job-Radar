CREATE TABLE `flag_settings` (
	`type` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_feedback` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`feedback` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`evidence_json` text NOT NULL,
	`explanation` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_flags_job_id_type` ON `job_flags` (`job_id`,`type`);--> statement-breakpoint
CREATE TABLE `job_scores` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`interview_chance` real,
	`job_quality` real,
	`combined` real,
	`breakdown_json` text NOT NULL,
	`computed_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`skills_text` text,
	`years_experience` real,
	`updated_at` integer NOT NULL
);
