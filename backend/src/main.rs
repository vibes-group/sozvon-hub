use std::io::Write;
use std::net::IpAddr;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto;
use hyper_util::server::graceful::GracefulShutdown;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use sozvon_hub::config::{self, Config};
use sozvon_hub::db::Db;
use sozvon_hub::http::server::{self, App};
use sozvon_hub::sfu::net::Mux;
use sozvon_hub::{auth, filestore, log, ratelimit, rooms, turn, util};

/// Internal endpoints get their own listener so the public port can never
/// serve /internal/*. Bound on all interfaces so sibling containers reach it.
const INTERNAL_ADDR: &str = "0.0.0.0:8081";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Advertised by the SFU in dev, when PUBLIC_IP is unset.
const DEV_SFU_IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);

fn fatal(msg: impl std::fmt::Display) -> ! {
    log!("{msg}");
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let cfg = Config::load().unwrap_or_else(|e| fatal(format!("config: {e}")));
    if let Err(e) = cfg.validate() {
        fatal(format!("config: {e}"));
    }
    if cfg.allow_insecure {
        log!("WARNING: APP_ALLOW_INSECURE=true — insecure dev mode, do not expose publicly");
    }
    // The SFU needs a literal address to advertise; Go handed PUBLIC_IP to
    // pion unchecked.
    let public_ip: Option<IpAddr> = (!cfg.public_ip.is_empty())
        .then(|| cfg.public_ip.parse().unwrap_or_else(|_| fatal(format!("config: PUBLIC_IP {:?} is not an IP address", cfg.public_ip))));

    let db = Arc::new(Db::open(&cfg.db_path).unwrap_or_else(|e| fatal(format!("db: {e}"))));
    let data_dir = cfg.db_path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let turn_secret = util::hex(&load_or_create_secret(data_dir, "turn.secret", 32).unwrap_or_else(|e| fatal(format!("turn secret: {e}"))));

    let auth = Arc::new(auth::Service::new(db.clone(), auth::Config { cookie_secure: cfg.cookie_secure, ..auth::Config::default() }));
    if cfg.bootstrap_invite {
        let svc = auth.clone();
        match sozvon_hub::http::blocking(move || svc.create_invite("", false, "")).await {
            Ok(invite) => log!("bootstrap invite created; token={}", invite.token),
            Err(auth::Error::Forbidden) => log!("bootstrap invite skipped: users already exist"),
            Err(e) => fatal(format!("bootstrap invite: {e}")),
        }
    }

    // Literal IP, not the hostname: it may proxy through a CDN that drops UDP.
    let (stun_url, turn_url) = match public_ip {
        Some(_) => (format!("stun:{}:{}", cfg.public_ip, cfg.turn_port), format!("turn:{}:{}?transport=udp", cfg.public_ip, cfg.turn_port)),
        None => (String::new(), String::new()),
    };

    // Chat attachments live only as long as the call: deleted when the room
    // ends, TTL-swept as a backstop. The per-upload cap mirrors the
    // frontend's MAX_UPLOAD_BYTES.
    let files = filestore::Store::new(filestore::Config {
        temp_dir: data_dir.join("uploads"),
        ttl: Duration::from_secs(2 * 3600),
        ttl_hard_cap: rooms::ROOM_TTL,
        max_upload_bytes: 100 << 20,
        max_total_bytes: 1 << 30,
        janitor_interval: Duration::from_secs(60),
    })
    .unwrap_or_else(|e| fatal(format!("filestore: {e}")));

    let mux = Mux::bind(public_ip.unwrap_or(DEV_SFU_IP), cfg.udp_port_min, cfg.udp_port_max)
        .await
        .unwrap_or_else(|e| fatal(format!("sfu init: {e}")));
    let rooms = rooms::Manager::new(
        db.clone(),
        rooms::Config {
            app_hostname: cfg.app_hostname.clone(),
            room_ttl: rooms::ROOM_TTL,
            grace_period: rooms::GRACE_PERIOD,
            mux: mux.clone(),
            files: files.clone(),
        },
    );
    {
        let rooms = rooms.clone();
        if let Err(e) = sozvon_hub::http::blocking(move || rooms.reconcile_active_on_startup()).await {
            fatal(format!("rooms reconcile: {e}"));
        }
    }
    let shutdown = CancellationToken::new();
    tokio::spawn(rooms.clone().run(shutdown.clone()));

    let turn_server = match public_ip {
        Some(_) => Some(
            turn::start(turn::Config {
                realm: cfg.turn_realm.clone(),
                shared_secret: turn_secret.clone(),
                public_ip: cfg.public_ip.clone(),
                listen_addr: format!("0.0.0.0:{}", cfg.turn_port),
                min_relay_port: cfg.turn_relay_min,
                max_relay_port: cfg.turn_relay_max,
            })
            .await
            .unwrap_or_else(|e| fatal(format!("turn init: {e}"))),
        ),
        None => {
            log!("PUBLIC_IP unset (dev) — TURN server and ICE config disabled");
            None
        }
    };

    let app = Arc::new(App {
        auth,
        rooms: rooms.clone(),
        files: files.clone(),
        api_limiter: ratelimit::Limiter::new(ratelimit::Config::new(server::GLOBAL_RATE, server::GLOBAL_BURST)),
        auth_limiter: ratelimit::Limiter::new(ratelimit::Config::new(server::AUTH_RATE, server::AUTH_BURST)),
        stun_url,
        turn_url,
        turn_secret,
        trusted_proxies: cfg.trusted_proxies.clone(),
        web_dir: cfg.web_dir.clone(),
        shutdown: shutdown.clone(),
    });

    let public = TcpListener::bind(config::listen_addr(&cfg.addr)).await.unwrap_or_else(|e| fatal(format!("http server: {e}")));
    log!("listening on {}, serving web from {}", cfg.addr, cfg.web_dir.display());
    let internal = TcpListener::bind(INTERNAL_ADDR).await.unwrap_or_else(|e| fatal(format!("http server: {e}")));
    let graceful = GracefulShutdown::new();
    let stop = shutdown_signal();
    tokio::pin!(stop);

    loop {
        tokio::select! {
            sig = &mut stop => {
                log!("shutdown: received {sig}, draining...");
                break;
            }
            Ok((tcp, peer)) = public.accept() => {
                let app = app.clone();
                let svc = service_fn(move |req| {
                    let app = app.clone();
                    async move { Ok::<_, std::convert::Infallible>(server::handle(app, sozvon_hub::http::boxed_request(req), peer).await) }
                });
                serve_conn(&graceful, tcp, svc);
            }
            Ok((tcp, _)) = internal.accept() => {
                let app = app.clone();
                let svc = service_fn(move |req| {
                    let app = app.clone();
                    async move { Ok::<_, std::convert::Infallible>(server::handle_internal(app, sozvon_hub::http::boxed_request(req)).await) }
                });
                serve_conn(&graceful, tcp, svc);
            }
        }
    }

    // Rooms first: open WebSockets would otherwise hold the drain open.
    rooms.close();
    shutdown.cancel();
    if tokio::time::timeout(SHUTDOWN_GRACE, graceful.shutdown()).await.is_err() {
        log!("shutdown: http: drain timed out");
    }
    if let Some(t) = turn_server
        && let Err(e) = t.close().await
    {
        log!("shutdown: turn: {e}");
    }
    mux.close();
    files.close();
    log!("shutdown: done");
}

/// Reads dataDir/name, creating it with `size` random bytes on first run.
/// Wiping the data dir invalidates outstanding TURN credentials, which is fine.
fn load_or_create_secret(dir: &Path, name: &str, size: usize) -> Result<Vec<u8>, String> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| format!("create data dir: {e}"))?;
    let path = dir.join(name);
    if let Ok(b) = std::fs::read(&path)
        && b.len() >= size
    {
        return Ok(b);
    }
    let mut b = vec![0u8; size];
    getrandom::fill(&mut b).map_err(|e| format!("generate secret: {e}"))?;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut f| f.write_all(&b))
        .map_err(|e| format!("write secret {name}: {e}"))?;
    Ok(b)
}

fn serve_conn<S>(graceful: &GracefulShutdown, tcp: tokio::net::TcpStream, svc: S)
where
    S: hyper::service::Service<http::Request<hyper::body::Incoming>, Response = sozvon_hub::http::Resp, Error = std::convert::Infallible>
        + Send
        + 'static,
    S::Future: Send + 'static,
{
    let mut builder = auto::Builder::new(TokioExecutor::new());
    builder.http1().timer(TokioTimer::new()).header_read_timeout(HEADER_READ_TIMEOUT);
    let conn = builder.serve_connection_with_upgrades(TokioIo::new(tcp), svc).into_owned();
    let fut = graceful.watch(conn);
    tokio::spawn(async move {
        let _ = fut.await;
    });
}

async fn shutdown_signal() -> &'static str {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => "terminated",
        _ = int.recv() => "interrupt",
    }
}
