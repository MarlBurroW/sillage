ALTER TABLE `attachments` ADD `card_id` text REFERENCES cards(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `idx_attachments_card` ON `attachments` (`card_id`);