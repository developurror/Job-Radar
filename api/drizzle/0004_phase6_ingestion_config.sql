CREATE TABLE `ingestion_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`keywords` text,
	`country` text,
	`province_state` text,
	`city` text,
	`field` text,
	`enabled_sources` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`field_key` text NOT NULL,
	`field_value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_credentials_source_field` ON `source_credentials` (`source_id`,`field_key`);