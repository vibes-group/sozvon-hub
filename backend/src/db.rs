//! SQLite storage: one connection behind a mutex, migrations embedded from
//! `migrations/*.sql` and tracked in `schema_migrations` by file name, exactly
//! as the Go backend did, so an existing database opens with nothing re-applied.
//!
//! All access is synchronous; async callers go through `spawn_blocking` (see
//! `http::blocking`). SQLite has a single writer anyway, and the queries are
//! sub-millisecond, so one serialised connection never sees SQLITE_BUSY from
//! itself and needs no pool.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use time::OffsetDateTime;

/// Sorted by name: applied in this order, recorded by name.
const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_accounts.sql", include_str!("../migrations/0001_accounts.sql")),
    ("0002_rooms.sql", include_str!("../migrations/0002_rooms.sql")),
    ("0003_user_name.sql", include_str!("../migrations/0003_user_name.sql")),
    ("0004_user_admin.sql", include_str!("../migrations/0004_user_admin.sql")),
    ("0005_user_can_invite.sql", include_str!("../migrations/0005_user_can_invite.sql")),
    ("0006_admin_notes.sql", include_str!("../migrations/0006_admin_notes.sql")),
    ("0007_drop_invite_token.sql", include_str!("../migrations/0007_drop_invite_token.sql")),
    ("0008_room_name.sql", include_str!("../migrations/0008_room_name.sql")),
    ("0009_room_participants.sql", include_str!("../migrations/0009_room_participants.sql")),
    ("0010_room_empty_since.sql", include_str!("../migrations/0010_room_empty_since.sql")),
];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        if path.as_os_str().is_empty() {
            return Err("sqlite path is required".into());
        }
        let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("create sqlite dir: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open sqlite: {e}"))?;
        configure(&conn).map_err(|e| format!("ping sqlite: {e}"))?;
        migrate(&conn)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    /// Runs `f` on the connection, blocking until it is free. A panic inside
    /// an earlier call leaves the connection usable (SQLite rolls back an
    /// unfinished transaction when its guard drops).
    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> T) -> T {
        f(&mut self.conn.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// The Go DSN's pragmas. `_txlock=immediate` maps to callers opening
/// transactions with `TransactionBehavior::Immediate`.
fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_millis(5000))?;
    conn.pragma_update(None, "foreign_keys", "on")?;
    conn.pragma_update(None, "journal_mode", "wal")?;
    conn.pragma_update(None, "synchronous", "normal")?;
    conn.pragma_update(None, "temp_store", "memory")
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "create table if not exists schema_migrations (
			version text primary key,
			applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)",
    )
    .map_err(|e| format!("ensure schema_migrations: {e}"))?;
    for (name, sql) in MIGRATIONS {
        let applied = conn
            .query_row("select version from schema_migrations where version = ?", [name], |_| Ok(()))
            .optional()
            .map_err(|e| format!("check migration {name}: {e}"))?
            .is_some();
        if applied {
            continue;
        }
        let tx = rusqlite::Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
            .map_err(|e| format!("begin migration {name}: {e}"))?;
        tx.execute_batch(sql).map_err(|e| format!("apply migration {name}: {e}"))?;
        tx.execute("insert into schema_migrations (version) values (?)", [name]).map_err(|e| format!("record migration {name}: {e}"))?;
        tx.commit().map_err(|e| format!("commit migration {name}: {e}"))?;
    }
    Ok(())
}

/// The app's timestamp layout (Go `2006-01-02T15:04:05.000000000Z`): UTC, always
/// nine fractional digits, so stored values compare correctly as strings.
pub fn timestamp(t: SystemTime) -> String {
    let dt = OffsetDateTime::from(t);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        dt.year(),
        u8::from(dt.month()),
        dt.day(),
        dt.hour(),
        dt.minute(),
        dt.second(),
        dt.nanosecond()
    )
}

/// Inverse of `timestamp`; like Go's time.Parse with that layout, anything but
/// exactly nine fractional digits is rejected.
pub fn parse_timestamp(s: &str) -> Option<SystemTime> {
    let fmt = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:9]Z");
    let dt = time::PrimitiveDateTime::parse(s, &fmt).ok()?;
    Some(SystemTime::from(dt.assume_utc()))
}

/// Whether a SQLite error is a uniqueness violation (Go matched "unique" in
/// the driver's message).
pub fn is_unique_violation(e: &rusqlite::Error) -> bool {
    e.to_string().to_lowercase().contains("unique")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_list_matches_directory() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let mut on_disk: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        on_disk.sort();
        let embedded: Vec<&str> = MIGRATIONS.iter().map(|(n, _)| *n).collect();
        assert_eq!(on_disk, embedded);
    }

    #[test]
    fn reopen_applies_nothing() {
        let dir = crate::testkit::TempDir::new();
        let path = dir.0.join("nested/test.db");
        let count = |db: &Db| db.with(|c| c.query_row("select count(*) from schema_migrations", [], |r| r.get::<_, i64>(0)).unwrap());
        let first = Db::open(&path).unwrap();
        assert_eq!(count(&first), MIGRATIONS.len() as i64);
        let stamp = first.with(|c| c.query_row("select max(applied_at) from schema_migrations", [], |r| r.get::<_, String>(0)).unwrap());
        drop(first);
        let again = Db::open(&path).unwrap();
        assert_eq!(count(&again), MIGRATIONS.len() as i64);
        let stamp2 = again.with(|c| c.query_row("select max(applied_at) from schema_migrations", [], |r| r.get::<_, String>(0)).unwrap());
        assert_eq!(stamp, stamp2);
        let fk: i64 = again.with(|c| c.query_row("pragma foreign_keys", [], |r| r.get(0)).unwrap());
        let mode: String = again.with(|c| c.query_row("pragma journal_mode", [], |r| r.get(0)).unwrap());
        assert_eq!((fk, mode.as_str()), (1, "wal"));
    }

    #[test]
    fn timestamps_match_go_layout() {
        let t = std::time::UNIX_EPOCH + Duration::new(1_782_734_400, 120_000_000);
        assert_eq!(timestamp(t), "2026-06-29T12:00:00.120000000Z");
        assert_eq!(parse_timestamp("2026-06-29T12:00:00.120000000Z"), Some(t));
        assert_eq!(timestamp(std::time::UNIX_EPOCH + Duration::from_secs(1_782_734_400)), "2026-06-29T12:00:00.000000000Z");
        assert_eq!(parse_timestamp("2026-06-29T12:00:00.120Z"), None, "SQLite strftime layout is not the app's");
        assert_eq!(parse_timestamp("2026-06-29T12:00:00Z"), None);
        assert_eq!(parse_timestamp(""), None);
    }
}
