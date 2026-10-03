-- The directory of each organization's trees: a tree Durable Object knows
-- its own tree but not its siblings, so the Api records every successful
-- init here (src/api/directory.ts) and lists them from here.
create table "ficus_tree" (
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "createdAt" integer not null,
  primary key ("organizationId", "name")
);
