create table users (
  id text primary key,
  username text unique collate nocase not null,
  password_hash text not null,
  disabled_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash blob not null unique,
  user_agent text,
  ip_hash blob,
  last_used_at text,
  expires_at text not null,
  revoked_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index sessions_user_active_idx
  on sessions(user_id, expires_at)
  where revoked_at is null;

create table account_invites (
  id text primary key,
  token_hash blob not null unique,
  token text,
  invited_by text references users(id) on delete set null,
  expires_at text not null,
  used_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index account_invites_active_idx
  on account_invites(expires_at)
  where used_at is null;
