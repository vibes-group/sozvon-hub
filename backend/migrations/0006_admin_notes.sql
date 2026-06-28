-- Admin's private per-user note (visible only to the admin), plus invite-carried
-- pre-grants so an admin can set a new user's note and invite-permission directly
-- in the invitation link.
alter table users add column admin_note text not null default '';
alter table account_invites add column grant_can_invite integer not null default 0;
alter table account_invites add column admin_note text not null default '';
