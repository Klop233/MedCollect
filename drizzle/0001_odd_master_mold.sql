ALTER TABLE `medicines` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `medicines` ADD `cover_key` text;--> statement-breakpoint
ALTER TABLE `medicines` ADD `cover_updated_at` text;