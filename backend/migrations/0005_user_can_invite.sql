-- Permission to create registration invites. All current users are grandfathered
-- in (true); new accounts default to false — only an admin can grant it.
alter table users add column can_invite integer not null default 0;
update users set can_invite = 1;
