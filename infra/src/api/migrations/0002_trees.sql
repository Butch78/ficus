-- The directory of each organization's trees: a tree Durable Object knows
-- its own tree but not its siblings, so the Api records every successful
-- plant here (src/api/directory.ts) and lists them from here.
create table "ficus_tree" (
  "organizationId" text not null references "organization" ("id") on delete cascade,
  "name" text not null,
  "plantedAt" integer not null,
  primary key ("organizationId", "name")
);
