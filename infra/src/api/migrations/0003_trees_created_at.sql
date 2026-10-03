-- The directory's timestamp says when a tree was listed, in plain words
-- (0002 named it after the old vocabulary). Renamed, not rewritten: 0002 is
-- already applied on existing stages.
alter table "ficus_tree" rename column "plantedAt" to "createdAt";
