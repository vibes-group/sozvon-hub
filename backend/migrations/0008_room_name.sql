-- Human-readable room name, shown in listings instead of the unguessable slug.
-- The slug stays the URL handle; the name is just a label the creator picks (or
-- an auto-generated friendly one when left blank).
alter table rooms add column name text not null default '';
