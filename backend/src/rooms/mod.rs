//! Ephemeral video rooms: a row in the `rooms` table plus, while in use, a
//! live SFU room created on first join over the shared `Mux`. When the last
//! participant leaves, the room survives a grace period so a reload rejoins
//! the same call; still empty when it lapses, the room is torn down and its
//! link ended.
//!
//! Liveness is durable: the last leaver stamps `empty_since`, a (re)join clears
//! it, and the sweeper ends rooms empty past the grace period and pending links
//! past their TTL. The column survives a restart, so rooms left `active` by a
//! crash are reconciled and reaped instead of lingering.
//!
//! Methods block on the database; async callers use `spawn_blocking`.

mod names;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::db::{Db, parse_timestamp, timestamp};
use crate::filestore;
use crate::log;
use crate::sfu::protocol::PeerInfo;
use crate::sfu::{Room, RoomConfig, RoomHooks, net::Mux};
use crate::util::random_bytes;

/// Lowercase base32 without ambiguous characters. 16 chars ≈ 80 bits: the
/// slug is the access control, so it must be unguessable.
const SLUG_ALPHABET: &[u8; 32] = b"abcdefghijkmnpqrstuvwxyz23456789";
/// How long a fresh link stays joinable before anyone joins it.
pub const ROOM_TTL: Duration = Duration::from_secs(24 * 3600);
/// How long an emptied room waits for a reconnect before it ends.
pub const GRACE_PERIOD: Duration = Duration::from_secs(5 * 60);
/// Ended rows are kept this long for history/debugging, then pruned.
const ENDED_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub struct Config {
    pub app_hostname: String,
    pub room_ttl: Duration,
    pub grace_period: Duration,
    pub mux: Arc<Mux>,
    pub files: Arc<filestore::Store>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    NotFound,
    Db(String),
}

fn db_err(ctx: &str) -> impl FnOnce(rusqlite::Error) -> Error + '_ {
    move |e| Error::Db(format!("{ctx}: {e}"))
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotFound => f.write_str("room not found"),
            Error::Db(e) => f.write_str(e),
        }
    }
}

/// A freshly minted room.
#[derive(Debug, Serialize)]
pub struct RoomInfo {
    pub slug: String,
    pub url: String,
    pub name: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

/// A room in a user's list (created or joined). `participants` is who is in
/// the call right now; `closes_at` is when an emptied room's grace lapses.
#[derive(Debug, Serialize)]
pub struct RoomSummary {
    pub slug: String,
    pub url: String,
    pub name: String,
    pub status: String,
    pub participants: usize,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "closesAt", skip_serializing_if = "String::is_empty")]
    pub closes_at: String,
}

/// The join screen's view of a room.
#[derive(Debug, Serialize)]
pub struct RoomView {
    pub slug: String,
    pub name: String,
    pub joinable: bool,
}

struct LiveRoom {
    room: Arc<Room>,
    /// Connected peer id → chat-only. Chat-only peers keep the room occupied
    /// but never make it a call.
    peers: HashMap<String, bool>,
}

pub struct Manager {
    db: Arc<Db>,
    cfg: Config,
    live: Mutex<HashMap<String, LiveRoom>>,
    hooks: Arc<dyn RoomHooks>,
    /// Test clock; None is the wall clock.
    clock: Mutex<Option<SystemTime>>,
}

/// Breaks the Manager → Room → hooks → Manager cycle.
struct Hooks(Weak<Manager>);

impl RoomHooks for Hooks {
    fn peer_joined(&self, room: &str, info: &PeerInfo) {
        if let Some(m) = self.0.upgrade() {
            m.peer_joined(room, &info.id, info.chat_only);
        }
    }

    fn peer_left(&self, room: &str, id: &str) {
        if let Some(m) = self.0.upgrade() {
            m.peer_left(room, id);
        }
    }

    fn peer_updated(&self, _room: &str, _info: &PeerInfo) {}
}

impl Manager {
    pub fn new(db: Arc<Db>, cfg: Config) -> Arc<Manager> {
        Arc::new_cyclic(|me| Manager { db, cfg, live: Mutex::default(), hooks: Arc::new(Hooks(me.clone())), clock: Mutex::new(None) })
    }

    fn now(&self) -> SystemTime {
        self.clock.lock().unwrap().unwrap_or_else(SystemTime::now)
    }

    fn now_ts(&self) -> String {
        timestamp(self.now())
    }

    /// Mints a pending room owned by `created_by`. A blank name gets a
    /// generated one.
    pub fn create(&self, created_by: &str, name: &str) -> Result<RoomInfo, Error> {
        let slug = new_slug();
        let name = if name.is_empty() { names::generate_name() } else { name.to_string() };
        let expires_at = timestamp(self.now() + self.cfg.room_ttl);
        self.db
            .with(|c| {
                c.execute(
                    "insert into rooms (slug, created_by, name, status, expires_at)
		values (?, ?, ?, 'pending', ?)",
                    params![slug, created_by, name, expires_at],
                )
            })
            .map_err(db_err("insert room"))?;
        Ok(RoomInfo { url: format!("/r/{slug}"), slug, name, expires_at })
    }

    /// Only the creator may rename; a missing or foreign room is NotFound.
    pub fn rename(&self, created_by: &str, slug: &str, name: &str) -> Result<(), Error> {
        let now = self.now_ts();
        let n = self
            .db
            .with(|c| {
                c.execute(
                    "update rooms set name = ?, updated_at = ?
		where slug = ? and created_by = ? and status != 'ended'",
                    params![name, now, slug, created_by],
                )
            })
            .map_err(db_err("rename room"))?;
        if n == 0 { Err(Error::NotFound) } else { Ok(()) }
    }

    fn live_participants(&self, slug: &str) -> usize {
        self.live.lock().unwrap().get(slug).map_or(0, |lr| lr.peers.len())
    }

    /// Whether any room holds a conversation (what a deploy waits out):
    /// two peers that can hear each other. Chat-only peers have no media and
    /// one peer alone has no one on the other side.
    pub fn has_active_call(&self) -> bool {
        self.live.lock().unwrap().values().any(|lr| lr.peers.values().filter(|chat_only| !**chat_only).take(2).count() == 2)
    }

    /// empty_since + grace, or "" while occupied (or unparseable).
    fn closes_at(&self, empty_since: Option<String>) -> String {
        empty_since.and_then(|s| parse_timestamp(&s)).map(|t| timestamp(t + self.cfg.grace_period)).unwrap_or_default()
    }

    fn summaries(&self, sql: &str, args: impl rusqlite::Params, what: &str) -> Result<Vec<RoomSummary>, Error> {
        let rows = self
            .db
            .with(|c| {
                let mut stmt = c.prepare(sql)?;
                let rows = stmt.query_map(args, |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(db_err(what))?;
        Ok(rows
            .into_iter()
            .map(|(slug, name, status, created_at, expires_at, empty_since)| RoomSummary {
                url: format!("/r/{slug}"),
                participants: self.live_participants(&slug),
                closes_at: self.closes_at(empty_since),
                slug,
                name,
                status,
                created_at,
                expires_at,
            })
            .collect())
    }

    /// The caller's still-usable rooms, newest first. Ended links are dead.
    pub fn list_by_creator(&self, created_by: &str) -> Result<Vec<RoomSummary>, Error> {
        self.summaries(
            "select slug, name, status, created_at, expires_at, empty_since
		from rooms
		where created_by = ? and status != 'ended'
		  and (status = 'active' or expires_at > ?)
		order by created_at desc
		limit 100",
            params![created_by, self.now_ts()],
            "list rooms",
        )
    }

    /// Still-usable rooms the user joined but did not create, most recently
    /// joined first.
    pub fn list_joined(&self, user_id: &str) -> Result<Vec<RoomSummary>, Error> {
        self.summaries(
            "select r.slug, r.name, r.status, r.created_at, r.expires_at, r.empty_since
		from room_participants p
		join rooms r on r.slug = p.slug
		where p.user_id = ? and r.created_by != ? and r.status != 'ended'
		  and (r.status = 'active' or r.expires_at > ?)
		order by p.last_joined_at desc
		limit 100",
            params![user_id, user_id, self.now_ts()],
            "list joined rooms",
        )
    }

    /// Records a registered user's join for their "joined" list. Best-effort:
    /// a failure must not block the call. Guests keep history client-side.
    pub fn record_join(&self, slug: &str, user_id: &str) {
        let now = self.now_ts();
        if let Err(e) = self.db.with(|c| {
            c.execute(
                "insert into room_participants (slug, user_id, first_joined_at, last_joined_at)
		values (?, ?, ?, ?)
		on conflict(slug, user_id) do update set last_joined_at = excluded.last_joined_at",
                params![slug, user_id, now, now],
            )
        }) {
            log!("rooms: record join {slug:?}/{user_id:?}: {e}");
        }
    }

    fn status_row(&self, slug: &str) -> Result<(String, String, String), Error> {
        self.db
            .with(|c| {
                c.query_row("select name, status, expires_at from rooms where slug = ?", [slug], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .optional()
            })
            .map_err(db_err("select room"))?
            .ok_or(Error::NotFound)
    }

    /// Exists, not ended, and (if still pending) not past its TTL.
    pub fn joinable(&self, slug: &str) -> Result<bool, Error> {
        let (_, status, expires_at) = self.status_row(slug)?;
        Ok(self.status_joinable(&status, &expires_at))
    }

    pub fn get(&self, slug: &str) -> Result<RoomView, Error> {
        let (name, status, expires_at) = self.status_row(slug)?;
        Ok(RoomView { slug: slug.to_string(), name, joinable: self.status_joinable(&status, &expires_at) })
    }

    fn status_joinable(&self, status: &str, expires_at: &str) -> bool {
        match status {
            "active" => true,
            "pending" => parse_timestamp(expires_at).is_some_and(|exp| self.now() < exp),
            _ => false,
        }
    }

    /// The live SFU room for `slug`, built on first use; marks the row active
    /// and clears any empty countdown (a reconnect within the grace window).
    pub fn acquire(&self, slug: &str) -> Arc<Room> {
        let (room, fresh) = {
            let mut live = self.live.lock().unwrap();
            match live.get(slug) {
                Some(lr) => (lr.room.clone(), false),
                None => {
                    let room = Room::new(RoomConfig {
                        room_id: slug.to_string(),
                        app_hostname: self.cfg.app_hostname.clone(),
                        mux: self.cfg.mux.clone(),
                        hooks: self.hooks.clone(),
                        files: self.cfg.files.clone(),
                    });
                    live.insert(slug.to_string(), LiveRoom { room: room.clone(), peers: HashMap::new() });
                    (room, true)
                }
            }
        };
        if fresh {
            self.mark_active(slug);
        }
        // Also covers rebuilding a room left active by a restart.
        self.mark_occupied(slug);
        room
    }

    pub fn live_room(&self, slug: &str) -> Option<Arc<Room>> {
        self.live.lock().unwrap().get(slug).map(|lr| lr.room.clone())
    }

    /// Clearing the countdown here, not only in acquire, covers a reconnect
    /// that evicts its own stale session: the eviction's peer_left stamps the
    /// room empty a moment before its replacement joins.
    fn peer_joined(&self, slug: &str, id: &str, chat_only: bool) {
        let known = {
            let mut live = self.live.lock().unwrap();
            live.get_mut(slug).map(|lr| lr.peers.insert(id.to_string(), chat_only)).is_some()
        };
        if known {
            self.mark_occupied(slug);
        }
    }

    /// The last leaver starts the grace countdown instead of ending the room;
    /// the live room stays in memory so a reconnect reuses it.
    fn peer_left(&self, slug: &str, id: &str) {
        let empty = {
            let mut live = self.live.lock().unwrap();
            let Some(lr) = live.get_mut(slug) else { return };
            lr.peers.remove(id);
            lr.peers.is_empty()
        };
        if empty {
            self.mark_empty(slug);
        }
    }

    fn exec_logged(&self, what: &str, slug: &str, sql: &str, args: impl rusqlite::Params) {
        if let Err(e) = self.db.with(|c| c.execute(sql, args)) {
            log!("rooms: {what} {slug:?}: {e}");
        }
    }

    fn mark_occupied(&self, slug: &str) {
        self.exec_logged(
            "mark occupied",
            slug,
            "update rooms set empty_since = null
		where slug = ? and status = 'active'",
            [slug],
        );
    }

    fn mark_empty(&self, slug: &str) {
        self.exec_logged(
            "mark empty",
            slug,
            "update rooms set empty_since = ?
		where slug = ? and status = 'active'",
            params![self.now_ts(), slug],
        );
    }

    fn mark_active(&self, slug: &str) {
        let now = self.now_ts();
        self.exec_logged(
            "mark active",
            slug,
            "update rooms
		set status = 'active',
		    first_joined_at = coalesce(first_joined_at, ?),
		    updated_at = ?
		where slug = ? and status = 'pending'",
            params![now, now, slug],
        );
    }

    /// Restarts the empty countdown for rooms left active by a previous
    /// process: their peers were lost, so each gets a grace window to
    /// reconnect. Rooms already counting down keep their deadline. Run once,
    /// before serving joins.
    pub fn reconcile_active_on_startup(&self) -> Result<(), Error> {
        let n = self
            .db
            .with(|c| {
                c.execute(
                    "update rooms set empty_since = ?
		where status = 'active' and empty_since is null",
                    [self.now_ts()],
                )
            })
            .map_err(db_err("reconcile active rooms"))?;
        if n > 0 {
            log!("rooms: started empty countdown for {n} active room(s) from a previous run");
        }
        Ok(())
    }

    /// Sweeps every minute until cancelled.
    pub async fn run(self: Arc<Self>, cancel: CancellationToken) {
        let mut tick = tokio::time::interval(SWEEP_INTERVAL);
        tick.tick().await;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = tick.tick() => {
                    let m = self.clone();
                    let _ = tokio::task::spawn_blocking(move || m.sweep()).await;
                }
            }
        }
    }

    /// Ends pending rooms past their TTL and active rooms empty past the grace
    /// period, and prunes ended rooms past retention.
    pub fn sweep(&self) {
        let now = self.now();
        let now_s = timestamp(now);
        if let Err(e) = self.db.with(|c| {
            c.execute(
                "update rooms
		set status = 'ended', ended_at = ?, updated_at = ?
		where status = 'pending' and expires_at <= ?",
                params![now_s, now_s, now_s],
            )
        }) {
            log!("rooms: sweep: {e}");
        }
        self.end_rooms_empty_past(&timestamp(now - self.cfg.grace_period), &now_s);
        if let Err(e) = self.db.with(|c| {
            c.execute(
                "delete from rooms
		where status = 'ended' and ended_at is not null and ended_at <= ?",
                [timestamp(now - ENDED_RETENTION)],
            )
        }) {
            log!("rooms: prune ended: {e}");
        }
    }

    /// UPDATE … RETURNING is atomic, so a reconnect that cleared empty_since
    /// keeps its row out of the result.
    fn end_rooms_empty_past(&self, cutoff: &str, now: &str) {
        let slugs = self.db.with(|c| {
            let mut stmt = c.prepare(
                "update rooms set status = 'ended', ended_at = ?, updated_at = ?
		where status = 'active' and empty_since is not null and empty_since <= ?
		returning slug",
            )?;
            let rows = stmt.query_map(params![now, now, cutoff], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        });
        let slugs = match slugs {
            Ok(s) => s,
            Err(e) => {
                log!("rooms: sweep empty: {e}");
                return;
            }
        };
        for slug in slugs {
            self.teardown_live(&slug);
            self.cfg.files.delete_room(&slug);
            log!("rooms: {slug:?} empty past grace, ended");
        }
    }

    fn teardown_live(&self, slug: &str) {
        let lr = self.live.lock().unwrap().remove(slug);
        if let Some(lr) = lr {
            lr.room.close();
        }
    }

    /// Tears down every live room (shutdown). Active rows keep their status;
    /// the next startup's reconcile restarts their countdown.
    pub fn close(&self) {
        let rooms: Vec<LiveRoom> = self.live.lock().unwrap().drain().map(|(_, lr)| lr).collect();
        for lr in rooms {
            lr.room.close();
        }
    }
}

fn new_slug() -> String {
    let b = random_bytes::<10>();
    let mut v = b.iter().fold(0u128, |acc, &x| (acc << 8) | u128::from(x));
    let mut out = [0u8; 16];
    for c in out.iter_mut().rev() {
        *c = SLUG_ALPHABET[(v & 0x1f) as usize];
        v >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("ascii")
}
