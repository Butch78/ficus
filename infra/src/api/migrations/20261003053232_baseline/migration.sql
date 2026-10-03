-- Baseline: the database as the flat migrations (0001 Better Auth, 0002 and
-- 0003 the tree directory) left it, written so it is a no-op on a stage
-- that already applied them and creates everything on a fresh one.
-- Better Auth's statements are scripts/auth-schema.ts's output; ficus_tree
-- is src/api/schema.ts (snapshot.json) plus its foreign key, which Drizzle
-- does not track because organization is Better Auth's table.
create table if not exists "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table if not exists "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);
--> statement-breakpoint
create table if not exists "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table if not exists "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
--> statement-breakpoint
create table if not exists "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);
--> statement-breakpoint
create table if not exists "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);
--> statement-breakpoint
create table if not exists "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);
--> statement-breakpoint
create table if not exists "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);
--> statement-breakpoint
create index if not exists "session_userId_idx" on "session" ("userId");
--> statement-breakpoint
create index if not exists "account_userId_idx" on "account" ("userId");
--> statement-breakpoint
create index if not exists "verification_identifier_idx" on "verification" ("identifier");
--> statement-breakpoint
create index if not exists "member_organizationId_idx" on "member" ("organizationId");
--> statement-breakpoint
create index if not exists "member_userId_idx" on "member" ("userId");
--> statement-breakpoint
create index if not exists "invitation_organizationId_idx" on "invitation" ("organizationId");
--> statement-breakpoint
create index if not exists "invitation_email_idx" on "invitation" ("email");
--> statement-breakpoint
create index if not exists "apikey_configId_idx" on "apikey" ("configId");
--> statement-breakpoint
create index if not exists "apikey_referenceId_idx" on "apikey" ("referenceId");
--> statement-breakpoint
create index if not exists "apikey_key_idx" on "apikey" ("key");
--> statement-breakpoint
create table if not exists "ficus_tree" (
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "createdAt" integer not null,
  primary key ("organizationId", "name")
);
