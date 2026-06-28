create table rooms (
  slug text primary key,
  created_by text not null references users(id) on delete cascade,
  -- 'pending'  : minted, never joined yet — joinable until expires_at.
  -- 'active'   : has had >=1 participant and is currently in use.
  -- 'ended'    : the call emptied out, or the unused link expired. Not joinable.
  status text not null default 'pending'
    check (status in ('pending', 'active', 'ended')),
  expires_at text not null,
  first_joined_at text,
  ended_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index rooms_status_expiry_idx on rooms(status, expires_at);
