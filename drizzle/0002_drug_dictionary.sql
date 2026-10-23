CREATE TABLE `drug_dictionary` (
	`prefix` text PRIMARY KEY NOT NULL,
	`product_json` text NOT NULL,
	`fingerprint` text NOT NULL,
	`samples` integer DEFAULT 1 NOT NULL,
	`ambiguous` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
