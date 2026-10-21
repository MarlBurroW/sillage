CREATE TABLE `news_feeds` (
	`url` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`checked_at` integer NOT NULL,
	`error` text
);
