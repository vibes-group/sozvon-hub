-- Display name shown in calls, distinct from the login username. Backfill
-- existing accounts to their username so nobody ends up nameless.
alter table users add column name text not null default '';
update users set name = username where name = '';
