use super::*;
use crate::testkit::{TempDir, temp_db};

const CREATOR: &str = "creator-user-id";

struct T {
    m: Arc<Manager>,
    db: Arc<Db>,
    files: Arc<filestore::Store>,
    _dir: TempDir,
}

impl T {
    fn advance(&self, d: Duration) {
        let mut c = self.m.clock.lock().unwrap();
        *c = Some(c.unwrap() + d);
    }

    fn now(&self) -> SystemTime {
        self.m.now()
    }

    fn exec(&self, sql: &str, args: impl rusqlite::Params) {
        self.db.with(|c| c.execute(sql, args)).unwrap();
    }

    fn set_status(&self, slug: &str, status: &str) {
        self.exec("update rooms set status = ? where slug = ?", [status, slug]);
    }

    fn status(&self, slug: &str) -> String {
        self.db.with(|c| c.query_row("select status from rooms where slug = ?", [slug], |r| r.get(0))).unwrap()
    }

    fn empty_since(&self, slug: &str) -> Option<String> {
        self.db.with(|c| c.query_row("select empty_since from rooms where slug = ?", [slug], |r| r.get(0))).unwrap()
    }

    fn exists(&self, slug: &str) -> bool {
        self.db.with(|c| c.query_row("select count(*) from rooms where slug = ?", [slug], |r| r.get::<_, i64>(0))).unwrap() > 0
    }

    fn create(&self) -> RoomInfo {
        self.m.create(CREATOR, "").unwrap()
    }

    fn is_live(&self, slug: &str) -> bool {
        self.m.live.lock().unwrap().contains_key(slug)
    }

    /// An active row plus a live room holding `peers`: what acquire and
    /// peer_joined produce, without a WebSocket.
    fn seed_live(&self, peers: &[&str]) -> (String, Arc<Room>) {
        let slug = self.create().slug;
        self.set_status(&slug, "active");
        let room = self.m.acquire(&slug);
        for p in peers {
            self.m.peer_joined(&slug, p, false);
        }
        (slug, room)
    }
}

fn insert_user(db: &Db, id: &str) {
    db.with(|c| c.execute("insert into users (id, username, name, password_hash) values (?, ?, ?, ?)", [id, id, id, "x"])).unwrap();
}

/// A manager over a real DB with the creator present (rooms.created_by is a
/// foreign key) and a fixed clock the test owns.
async fn manager() -> T {
    let (db, dir) = temp_db();
    insert_user(&db, CREATOR);
    let files = filestore::Store::new(filestore::Config {
        temp_dir: dir.0.join("files"),
        ttl: Duration::from_secs(300),
        ttl_hard_cap: Duration::from_secs(1800),
        max_upload_bytes: 100,
        max_total_bytes: 0,
        janitor_interval: Duration::from_secs(3600),
    })
    .unwrap();
    let mux = Mux::bind("127.0.0.1".parse().unwrap(), 0, 0).await.unwrap();
    let m = Manager::new(
        db.clone(),
        Config {
            app_hostname: "localhost".into(),
            room_ttl: Duration::from_secs(3600),
            grace_period: GRACE_PERIOD,
            mux,
            files: files.clone(),
        },
    );
    *m.clock.lock().unwrap() = Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_782_734_400)); // 2026-06-29T12:00:00Z
    T { m, db, files, _dir: dir }
}

#[tokio::test]
async fn create() {
    let t = manager().await;
    let info = t.create();
    assert_eq!(info.slug.len(), 16);
    assert!(info.slug.bytes().all(|b| SLUG_ALPHABET.contains(&b)), "{}", info.slug);
    assert_eq!(info.url, format!("/r/{}", info.slug));
    assert_eq!(info.expires_at, "2026-06-29T13:00:00.000000000Z");
    assert!(!info.name.is_empty());
    assert_eq!(t.status(&info.slug), "pending");
    assert_eq!(t.m.create(CREATOR, "Planning").unwrap().name, "Planning");
}

#[tokio::test]
async fn joinable() {
    let t = manager().await;
    let slug = t.create().slug;
    assert_eq!(t.m.joinable(&slug), Ok(true));
    t.advance(Duration::from_secs(7200));
    assert_eq!(t.m.joinable(&slug), Ok(false), "pending past expiry");
    t.set_status(&slug, "active");
    assert_eq!(t.m.joinable(&slug), Ok(true), "active rooms ignore the TTL");
    t.set_status(&slug, "ended");
    assert_eq!(t.m.joinable(&slug), Ok(false));
    assert_eq!(t.m.joinable("does-not-exist"), Err(Error::NotFound));
    let v = t.m.get(&slug).unwrap();
    assert_eq!((v.slug.as_str(), v.joinable), (slug.as_str(), false));
    assert_eq!(t.m.get("nope").unwrap_err(), Error::NotFound);
}

#[tokio::test]
async fn rename() {
    let t = manager().await;
    let slug = t.create().slug;
    t.m.rename(CREATOR, &slug, "New").unwrap();
    assert_eq!(t.m.get(&slug).unwrap().name, "New");
    assert_eq!(t.m.rename("other", &slug, "X"), Err(Error::NotFound));
    t.set_status(&slug, "ended");
    assert_eq!(t.m.rename(CREATOR, &slug, "X"), Err(Error::NotFound));
}

#[tokio::test]
async fn list_by_creator() {
    let t = manager().await;
    let (first, second, third) = (t.create(), t.create(), t.create());
    for (r, ts) in [(&first, "00"), (&second, "01"), (&third, "02")] {
        t.exec("update rooms set created_at = ? where slug = ?", [format!("2026-06-29T12:00:{ts}.000000000Z"), r.slug.clone()]);
    }
    t.set_status(&first.slug, "ended");
    t.set_status(&second.slug, "active");
    insert_user(&t.db, "other");
    t.m.create("other", "").unwrap();

    let list = t.m.list_by_creator(CREATOR).unwrap();
    let slugs: Vec<&str> = list.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, [third.slug.as_str(), second.slug.as_str()], "newest first, ended and foreign rooms excluded");
    for r in &list {
        assert_eq!(r.url, format!("/r/{}", r.slug));
        assert_eq!(r.participants, 0);
        assert_eq!(r.closes_at, "");
    }
    // A pending link past its TTL drops out; an active one stays.
    t.advance(Duration::from_secs(7200));
    let slugs: Vec<String> = t.m.list_by_creator(CREATOR).unwrap().into_iter().map(|r| r.slug).collect();
    assert_eq!(slugs, std::slice::from_ref(&second.slug));
}

#[tokio::test]
async fn list_joined() {
    let t = manager().await;
    insert_user(&t.db, "guest");
    let (a, b, own) = (t.create(), t.create(), t.m.create("guest", "").unwrap());
    t.m.record_join(&a.slug, "guest");
    t.advance(Duration::from_secs(1));
    t.m.record_join(&b.slug, "guest");
    t.m.record_join(&own.slug, "guest");
    let slugs: Vec<String> = t.m.list_joined("guest").unwrap().into_iter().map(|r| r.slug).collect();
    assert_eq!(slugs, [b.slug.clone(), a.slug.clone()], "most recent first, own rooms excluded");
    t.advance(Duration::from_secs(1));
    t.m.record_join(&a.slug, "guest");
    assert_eq!(t.m.list_joined("guest").unwrap()[0].slug, a.slug, "rejoin bumps last_joined_at");
    let first: String =
        t.db.with(|c| c.query_row("select first_joined_at from room_participants where slug = ?", [&a.slug], |r| r.get(0))).unwrap();
    assert_eq!(first, "2026-06-29T12:00:00.000000000Z");
}

#[tokio::test]
async fn sweep_ends_expired_pending() {
    let t = manager().await;
    let stale = t.create().slug;
    let fresh = t.create().slug;
    t.set_status(&fresh, "active");
    t.advance(Duration::from_secs(7200));
    t.m.sweep();
    assert_eq!(t.status(&stale), "ended");
    assert_eq!(t.status(&fresh), "active");
}

#[tokio::test]
async fn sweep_prunes_old_ended_rooms() {
    let t = manager().await;
    let old = t.create().slug;
    let recent = t.create().slug;
    for (slug, ago) in [(&old, 8 * 24 * 3600), (&recent, 3600)] {
        t.set_status(slug, "ended");
        t.exec("update rooms set ended_at = ? where slug = ?", [timestamp(t.now() - Duration::from_secs(ago)), slug.clone()]);
    }
    t.m.sweep();
    assert!(!t.exists(&old));
    assert!(t.exists(&recent));
}

#[tokio::test]
async fn reconcile_active_on_startup() {
    let t = manager().await;
    let pending = t.create().slug;
    let occupied = t.create().slug;
    t.set_status(&occupied, "active");
    t.m.reconcile_active_on_startup().unwrap();
    assert!(t.empty_since(&occupied).is_some());
    assert!(t.empty_since(&pending).is_none());
    t.advance(2 * t.m.cfg.grace_period);
    t.m.sweep();
    assert_eq!(t.status(&occupied), "ended");
    assert_eq!(t.status(&pending), "pending");
}

#[tokio::test]
async fn empty_room_ended_after_grace() {
    let t = manager().await;
    let (slug, room) = t.seed_live(&["p1"]);
    let path = t.files.temp_path();
    std::fs::write(&path, b"x").unwrap();
    let upload = t.files.store(&slug, "a", "text/plain", 1, path.clone()).unwrap();
    t.m.peer_left(&slug, "p1");

    assert!(!room.is_closed());
    assert_eq!(t.status(&slug), "active");
    assert!(t.empty_since(&slug).is_some());
    assert!(t.is_live(&slug));
    assert!(t.m.list_by_creator(CREATOR).unwrap()[0].closes_at.ends_with(":05:00.000000000Z"));

    t.advance(t.m.cfg.grace_period - Duration::from_secs(60));
    t.m.sweep();
    assert_eq!(t.status(&slug), "active", "before grace lapses");

    t.advance(Duration::from_secs(120));
    t.m.sweep();
    assert_eq!(t.status(&slug), "ended");
    assert!(room.is_closed());
    assert!(!t.is_live(&slug));
    assert!(t.files.get(&upload.upload_id).is_none() && !path.exists(), "the room's chat files go with it");
}

#[tokio::test]
async fn reconnect_clears_empty_countdown() {
    let t = manager().await;
    let (slug, room) = t.seed_live(&["p1"]);
    t.m.peer_left(&slug, "p1");
    assert!(t.empty_since(&slug).is_some());
    assert!(Arc::ptr_eq(&t.m.acquire(&slug), &room), "reconnect reuses the live room");
    assert_eq!(t.empty_since(&slug), None);
    t.advance(2 * t.m.cfg.grace_period);
    t.m.sweep();
    assert_eq!(t.status(&slug), "active");
    assert!(!room.is_closed());
    assert!(t.is_live(&slug));
}

/// A reconnect evicting its own stale session drives peer_left then
/// peer_joined without passing through acquire.
#[tokio::test]
async fn evicted_reconnect_clears_empty_countdown() {
    let t = manager().await;
    let (slug, _room) = t.seed_live(&["stale"]);
    t.m.peer_left(&slug, "stale");
    assert!(t.empty_since(&slug).is_some());
    t.m.peer_joined(&slug, "fresh", false);
    assert_eq!(t.empty_since(&slug), None);
    t.advance(2 * t.m.cfg.grace_period);
    t.m.sweep();
    assert_eq!(t.status(&slug), "active");
    assert_eq!(t.m.list_by_creator(CREATOR).unwrap()[0].participants, 1);
}

#[tokio::test]
async fn acquire_activates_pending() {
    let t = manager().await;
    let slug = t.create().slug;
    t.m.acquire(&slug);
    assert_eq!(t.status(&slug), "active");
    let first: Option<String> =
        t.db.with(|c| c.query_row("select first_joined_at from rooms where slug = ?", [&slug], |r| r.get(0))).unwrap();
    assert_eq!(first.as_deref(), Some("2026-06-29T12:00:00.000000000Z"));
    assert!(t.m.live_room(&slug).is_some());
    t.m.close();
    assert!(t.m.live_room(&slug).is_none());
}

#[tokio::test]
async fn has_active_call() {
    let t = manager().await;
    assert!(!t.m.has_active_call());
    let room = t.m.acquire(&t.create().slug);
    for (name, peers, want) in [
        ("empty room", &[][..], false),
        ("one alone", &[("a", false)][..], false),
        ("lurkers only", &[("a", true), ("b", true), ("c", true)][..], false),
        ("one and a crowd of lurkers", &[("a", false), ("b", true), ("c", true)][..], false),
        ("two talking", &[("a", false), ("b", false)][..], true),
        ("two talking among lurkers", &[("a", false), ("b", true), ("c", false)][..], true),
    ] {
        t.m.live
            .lock()
            .unwrap()
            .insert("room".into(), LiveRoom { room: room.clone(), peers: peers.iter().map(|(id, c)| (id.to_string(), *c)).collect() });
        assert_eq!(t.m.has_active_call(), want, "{name}");
    }
}
