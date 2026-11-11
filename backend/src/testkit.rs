//! Test fixtures: a fully wired App over a temp dir (real SQLite, real SFU
//! mux), servable on a real port, with one registered user and one joinable
//! room created by that user.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::{Method, Request, header};
use tokio_util::sync::CancellationToken;

use crate::auth::{self, PasswordParams, SessionMeta, User};
use crate::db::Db;
use crate::filestore;
use crate::http::server::{self, App};
use crate::http::{Resp, full};
use crate::ratelimit;
use crate::rooms;
use crate::sfu::{Room, net::Mux};
use crate::util::{hex, random_bytes};

pub const PASSWORD: &str = "password123";

/// Cheap argon2 so suites run quickly; the KDF itself is tested with the real
/// defaults in auth::password.
pub fn fast_params() -> PasswordParams {
    PasswordParams { memory_kib: 8, iterations: 1, parallelism: 1, salt_bytes: 16, key_bytes: 32 }
}

/// A directory removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        let p = std::env::temp_dir().join(format!("sz-test-{}", hex(&random_bytes::<8>())));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A fresh, fully migrated database.
pub fn temp_db() -> (Arc<Db>, TempDir) {
    let dir = TempDir::new();
    (Arc::new(Db::open(&dir.0.join("test.db")).unwrap()), dir)
}

pub struct Env {
    pub app: Arc<App>,
    pub db: Arc<Db>,
    /// Slug of a joinable room created by `user`.
    pub room: String,
    pub user: User,
    token: String,
    mux: Arc<Mux>,
    _dir: TempDir,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.app.shutdown.cancel();
        self.app.rooms.close();
        self.mux.close();
        self.app.files.close();
    }
}

pub async fn env_with(files_cfg: impl FnOnce(PathBuf) -> filestore::Config) -> Env {
    let (db, dir) = temp_db();
    std::fs::create_dir_all(dir.0.join("web/assets")).unwrap();
    std::fs::write(dir.0.join("web/index.html"), "<html>app</html>").unwrap();
    std::fs::write(dir.0.join("web/assets/app.js"), "console.log(1)").unwrap();
    let auth = Arc::new(auth::Service::new(db.clone(), auth::Config { password_params: fast_params(), ..auth::Config::default() }));
    let files = filestore::Store::new(files_cfg(dir.0.join("tmp"))).unwrap();
    let mux = Mux::bind("127.0.0.1".parse().unwrap(), 0, 0).await.unwrap();
    let rooms = rooms::Manager::new(
        db.clone(),
        rooms::Config {
            app_hostname: "sz.example".into(),
            room_ttl: rooms::ROOM_TTL,
            grace_period: rooms::GRACE_PERIOD,
            mux: mux.clone(),
            files: files.clone(),
        },
    );
    let invite = auth.create_invite("", false, "").unwrap();
    let (token, user) = auth.register_with_invite(&SessionMeta::default(), &invite.token, "alice", PASSWORD).unwrap();
    let room = rooms.create(&user.id, "").unwrap().slug;
    let app = Arc::new(App {
        auth,
        rooms,
        files,
        api_limiter: ratelimit::Limiter::new(ratelimit::Config::new(server::GLOBAL_RATE, server::GLOBAL_BURST)),
        auth_limiter: ratelimit::Limiter::new(ratelimit::Config::new(server::AUTH_RATE, server::AUTH_BURST)),
        stun_url: "stun:stun.example.com:3478".into(),
        turn_url: "turn:turn.example.com:3478".into(),
        turn_secret: "shared-secret".into(),
        trusted_proxies: crate::config::parse_trusted_proxies("").unwrap(),
        web_dir: dir.0.join("web"),
        shutdown: CancellationToken::new(),
    });
    Env { app, db, room, user, token, mux, _dir: dir }
}

pub async fn env() -> Env {
    env_with(|tmp| filestore::Config {
        temp_dir: tmp,
        ttl: Duration::from_secs(300),
        ttl_hard_cap: Duration::from_secs(1800),
        max_upload_bytes: 1 << 20,
        max_total_bytes: 1 << 20,
        janitor_interval: Duration::from_secs(3600),
    })
    .await
}

impl Env {
    /// `Cookie` header value carrying the registered user's session.
    pub fn user_cookie(&self) -> String {
        format!("{}={}", auth::COOKIE_NAME, self.token)
    }

    pub fn live_room(&self, slug: &str) -> Option<Arc<Room>> {
        self.app.rooms.live_room(slug)
    }

    /// Another joinable room owned by the same user.
    pub fn new_room(&self) -> String {
        self.app.rooms.create(&self.user.id, "").unwrap().slug
    }

    pub async fn call(&self, method: Method, uri: &str, cookie: Option<&str>, headers: &[(&str, &str)], body: impl Into<Bytes>) -> Resp {
        let mut b = Request::builder().method(method).uri(uri).header(header::HOST, "sz.example");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let peer: SocketAddr = "127.0.0.1:40000".parse().unwrap();
        server::handle(self.app.clone(), b.body(full(body.into())).unwrap(), peer).await
    }

    pub async fn get(&self, uri: &str, cookie: Option<&str>) -> Resp {
        self.call(Method::GET, uri, cookie, &[], Bytes::new()).await
    }

    /// Serves the app on an ephemeral port; returns the port.
    pub async fn serve(&self) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = self.app.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, peer)) = listener.accept().await else { return };
                let app = app.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req| {
                        let app = app.clone();
                        async move { Ok::<_, std::convert::Infallible>(server::handle(app, crate::http::boxed_request(req), peer).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(tcp), svc)
                        .with_upgrades()
                        .await;
                });
            }
        });
        port
    }
}
