ALTER TABLE `user_profile` ADD `spoken_languages` text;--> statement-breakpoint
ALTER TABLE `user_profile` ADD `language_rule_enabled` integer DEFAULT 1 NOT NULL;