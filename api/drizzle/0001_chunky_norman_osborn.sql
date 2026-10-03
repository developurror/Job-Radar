CREATE TABLE `criteria` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`validator` text NOT NULL,
	`config_json` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_evaluations` (
	`job_id` integer PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`results_json` text NOT NULL,
	`evaluated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
