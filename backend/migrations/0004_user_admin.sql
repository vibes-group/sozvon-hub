-- Single-administrator marker. The partial unique index enforces at most one
-- admin at the database level: only one row may ever have is_admin = 1.
alter table users add column is_admin integer not null default 0;
create unique index users_single_admin on users(is_admin) where is_admin = 1;
