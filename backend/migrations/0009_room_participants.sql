-- Tracks which registered users have joined which rooms, so a user can see the
-- rooms they entered but did not create. Guests (no account) are not recorded
-- here — their history lives client-side in localStorage.
create table room_participants (
  slug text not null references rooms(slug) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  first_joined_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_joined_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (slug, user_id)
);

create index room_participants_user_idx on room_participants(user_id, last_joined_at);
