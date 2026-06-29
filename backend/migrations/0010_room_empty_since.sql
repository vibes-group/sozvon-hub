-- empty_since persists when an active room last emptied, so teardown survives a
-- process restart (the grace timer used to live only in memory). NULL means the
-- room is occupied (or pending/ended); a timestamp means it has been empty since
-- then, and the sweeper ends the room once that is older than the grace period.
-- Existing active rooms are backfilled in code on startup (ReconcileActiveOnStartup),
-- which writes the timestamp in the same format the app uses.
alter table rooms add column empty_since text;

create index rooms_empty_since_idx on rooms(status, empty_since);
