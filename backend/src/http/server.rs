//! Application state, routing and middleware, mirroring the Go ServeMux:
//! method-qualified routes (GET also serves HEAD), `{param}` is one non-empty
//! segment, and anything unmatched falls through to the SPA handler.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode, header};
use http_body::{Frame, SizeHint};
use http_body_util::BodyExt;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::{Body, Req, Resp, client_ip, error, go_duration_ms, go_quote, handlers, json, not_found, redirect, upload, web};
use crate::config::Prefix;
use crate::{auth, filestore, log, ratelimit, rooms, util};

/// Throttles password guessing and the argon2 cost of login, register and
/// password change: ~10 attempts a minute sustained.
pub const AUTH_RATE: f64 = 1.0 / 6.0;
pub const AUTH_BURST: u32 = 10;
/// Looser per-IP backstop over the whole /api surface.
pub const GLOBAL_RATE: f64 = 5.0;
pub const GLOBAL_BURST: u32 = 60;

pub struct App {
    pub auth: Arc<auth::Service>,
    pub rooms: Arc<rooms::Manager>,
    pub files: Arc<filestore::Store>,
    pub api_limiter: ratelimit::Limiter,
    pub auth_limiter: ratelimit::Limiter,
    /// Empty in dev without PUBLIC_IP: /api/config then lists no servers.
    pub stun_url: String,
    pub turn_url: String,
    pub turn_secret: String,
    /// CIDRs whose peer address may set X-Forwarded-For.
    pub trusted_proxies: Vec<Prefix>,
    pub web_dir: PathBuf,
    /// Cancelled on shutdown; parents every WebSocket session.
    pub shutdown: CancellationToken,
}

impl App {
    pub fn client_ip(&self, req: &Req, peer: SocketAddr) -> String {
        client_ip(peer, req.headers(), &self.trusted_proxies)
    }
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
}

pub fn json_error(status: StatusCode, code: &str) -> Resp {
    json(status, &ErrorBody { error: code })
}

/// 429 {"error":"rate_limited"} when `ip` is over budget.
fn limited(limiter: &ratelimit::Limiter, ip: &str) -> Option<Resp> {
    let retry = limiter.allow(ip).err()?;
    let mut r = json_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    if !retry.is_zero() {
        r.headers_mut().insert(header::RETRY_AFTER, retry_after(retry));
    }
    Some(r)
}

/// Whole seconds, rounded up, at least 1.
pub fn retry_after(d: Duration) -> HeaderValue {
    HeaderValue::from(util::ceil_secs(d).max(1))
}

/// Every public request: access log, the /api rate limit, then routing.
pub async fn handle(app: Arc<App>, req: Req, peer: SocketAddr) -> Resp {
    let path = req.uri().path().to_string();
    // Health probes and long-lived WebSockets are not logged.
    if path == "/healthz" || path.starts_with("/ws/") {
        return route(app, req, peer).await;
    }
    let start = Instant::now();
    let method = req.method().clone();
    // Routing matches unescaped segments, so the limit must too: /%61pi/ is /api/.
    let api = super::percent_decode(&path).is_some_and(|p| p.starts_with(b"/api/"));
    let resp = match api.then(|| limited(&app.api_limiter, &app.client_ip(&req, peer))).flatten() {
        Some(r) => r,
        None => route(app, req, peer).await,
    };
    // Logged once the body is fully written (or dropped), so streamed
    // responses report their real duration.
    let status = resp.status().as_u16();
    resp.map(|body| LoggedBody { inner: body, line: Some(AccessLine { method, path, status, start }) }.boxed_unsync())
}

struct LoggedBody {
    inner: Body,
    line: Option<AccessLine>,
}

struct AccessLine {
    method: Method,
    path: String,
    status: u16,
    start: Instant,
}

impl http_body::Body for LoggedBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for LoggedBody {
    fn drop(&mut self) {
        if let Some(l) = self.line.take() {
            let path = String::from_utf8_lossy(&super::percent_decode(&l.path).unwrap_or_else(|| l.path.clone().into_bytes())).into_owned();
            log!("http {} {} {} {}", l.method, go_quote(&path), l.status, go_duration_ms(l.start.elapsed()));
        }
    }
}

/// ServeMux redirects unclean paths before matching.
fn clean_redirect(req: &Req) -> Option<Resp> {
    let path = req.uri().path();
    let cleaned = super::clean_path(path);
    if cleaned == path || req.method() == Method::CONNECT {
        return None;
    }
    let loc = match req.uri().query() {
        Some(q) => format!("{cleaned}?{q}"),
        None => cleaned,
    };
    Some(redirect(req.method(), &loc, StatusCode::MOVED_PERMANENTLY))
}

async fn route(app: Arc<App>, req: Req, peer: SocketAddr) -> Resp {
    if let Some(r) = clean_redirect(&req) {
        return r;
    }
    let m = req.method().clone();
    let get = m == Method::GET || m == Method::HEAD;
    let (post, patch, delete) = (m == Method::POST, m == Method::PATCH, m == Method::DELETE);
    // Segments compare unescaped, like ServeMux.
    let segs: Vec<String> = req.uri().path()[1..]
        .split('/')
        .map(|s| super::percent_decode(s).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|| s.to_string()))
        .collect();
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let throttle = |req: &Req| limited(&app.auth_limiter, &app.client_ip(req, peer));

    let handled = match segs.as_slice() {
        ["healthz"] if get => Ok(handlers::healthz()),
        ["api", "auth", "me"] if get => handlers::auth_me(&app, req).await,
        ["api", "auth", "register"] if post => match throttle(&req) {
            Some(r) => Ok(r),
            None => handlers::auth_register(&app, req, peer).await,
        },
        ["api", "auth", "login"] if post => match throttle(&req) {
            Some(r) => Ok(r),
            None => handlers::auth_login(&app, req, peer).await,
        },
        ["api", "auth", "logout"] if post => handlers::auth_logout(&app, req).await,
        ["api", "account"] if patch => handlers::account_update(&app, req).await,
        ["api", "account", "password"] if post => match throttle(&req) {
            Some(r) => Ok(r),
            None => handlers::account_change_password(&app, req).await,
        },
        ["api", "invites"] if post => handlers::invite_create(&app, req).await,
        ["api", "invites"] if get => handlers::invites_list(&app, req).await,
        ["api", "invites", id] if delete && !id.is_empty() => handlers::invite_delete(&app, req, id.to_string()).await,
        ["api", "rooms"] if post => handlers::room_create(&app, req).await,
        ["api", "rooms"] if get => handlers::rooms_list(&app, req).await,
        ["api", "rooms", "joined"] if get => handlers::rooms_joined(&app, req).await,
        ["api", "rooms", slug] if patch && !slug.is_empty() => handlers::room_update(&app, req, slug.to_string()).await,
        ["api", "rooms", slug] if get && !slug.is_empty() => handlers::room_get(&app, slug.to_string()).await,
        ["api", "config"] if get => Ok(handlers::ice_config(&app)),
        ["api", "upload"] if post => Ok(upload::upload(&app, req).await),
        ["api", "file", id] if get && !id.is_empty() => Ok(upload::download(&app, req, id).await),
        ["api", "admin", "users"] if get => handlers::admin_users_list(&app, req).await,
        ["api", "admin", "users", id] if patch && !id.is_empty() => handlers::admin_user_update(&app, req, id.to_string()).await,
        ["api", "admin", "users", id] if delete && !id.is_empty() => handlers::admin_user_delete(&app, req, id.to_string()).await,
        ["ws", slug] if get && !slug.is_empty() => handlers::serve_ws(&app, req, slug.to_string()).await,
        _ => Ok(web::serve(&app.web_dir, req).await),
    };
    handled.unwrap_or_else(handlers::Reject::into_resp)
}

/// Internal listener (:8081): reachable by sibling containers only, never
/// routed through the public proxy.
pub async fn handle_internal(app: Arc<App>, req: Req) -> Resp {
    if let Some(r) = clean_redirect(&req) {
        return r;
    }
    if req.uri().path() != "/internal/call-status" {
        return not_found();
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let mut r = error(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        r.headers_mut().insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return r;
    }
    handlers::call_status(app.rooms.has_active_call())
}
