CREATE TABLE IF NOT EXISTS `ficus_usage` (
	`organizationId` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `ficus_usage_pk` PRIMARY KEY(`organizationId`, `day`, `kind`)
);
