CREATE TABLE IF NOT EXISTS `ficus_github_link` (
	`organizationId` text NOT NULL,
	`tree` text NOT NULL,
	`repositoryId` integer NOT NULL,
	`fullName` text NOT NULL,
	`branch` text NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `ficus_github_link_pk` PRIMARY KEY(`organizationId`, `tree`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ficus_github_link_repository` ON `ficus_github_link` (`repositoryId`,`branch`);