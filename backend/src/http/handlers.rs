//! The REST handlers. Status codes, error codes and JSON shapes are the Go
//! backend's, which the frontend relies on.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use http::{HeaderValue, StatusCode, header};
use serde::ser::{Serialize, SerializeMap, Serializer};
use sha2::Digest;

use super::jsonbody::{Invalid, Object, first_value, read_limited};
use super::server::{App, json_error, retry_after};
use super::{Req, Resp, blocking, error, full, json as json_resp, no_content, response, ws};
use crate::auth::{self, SessionMeta, User};
use crate::{log, rooms, turn, util};

/// Covers a typical call and brief reconnects; short enough to limit exposure
/// if a credential leaks.
const TURN_CREDS_TTL: Duration = Duration::from_secs(6 * 3600);

pub fn healthz() -> Resp {
    let mut r = response(StatusCode::OK, full("ok"));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

pub fn call_status(active: bool) -> Resp {
    let mut r = response(StatusCode::OK, full(if active { "active\n" } else { "idle\n" }));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

/// `{"<key>": value}` with the value's own field order (Go's
/// map[string]any{key: v}).
struct One<'a, T>(&'static str, &'a T);

impl<T: Serialize> Serialize for One<'_, T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(1))?;
        m.serialize_entry(self.0, self.1)?;
        m.end()
    }
}

/// A handler's early answer: an error response short-circuiting through `?`
/// (boxed: responses are large).
pub struct Reject(Box<Resp>);

pub type Handled = Result<Resp, Reject>;

impl Reject {
    pub fn into_resp(self) -> Resp {
        *self.0
    }
}

impl From<Resp> for Reject {
    fn from(r: Resp) -> Reject {
        Reject(Box::new(r))
    }
}

impl From<auth::Error> for Reject {
    fn from(e: auth::Error) -> Reject {
        auth_error(e).into()
    }
}

impl From<Invalid> for Reject {
    fn from(_: Invalid) -> Reject {
        invalid_request().into()
    }
}

fn internal_error() -> Resp {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}

fn logged_internal(what: &str, e: impl std::fmt::Display) -> Reject {
    log!("{what}: {e}");
    internal_error().into()
}

fn invalid_request() -> Resp {
    json_error(StatusCode::BAD_REQUEST, "invalid_request")
}

fn auth_error(e: auth::Error) -> Resp {
    use auth::Error::*;
    match e {
        Locked(wait) => {
            let mut r = json_error(StatusCode::TOO_MANY_REQUESTS, "too_many_attempts");
            r.headers_mut().insert(header::RETRY_AFTER, retry_after(wait));
            r
        }
        NotAuthenticated => json_error(StatusCode::UNAUTHORIZED, "not_authenticated"),
        InvalidCredentials => json_error(StatusCode::UNAUTHORIZED, "invalid_credentials"),
        UsernameTaken => json_error(StatusCode::CONFLICT, "username_taken"),
        InviteRequired => json_error(StatusCode::BAD_REQUEST, "invite_required"),
        InvalidInvite => json_error(StatusCode::FORBIDDEN, "invalid_invite"),
        Forbidden => json_error(StatusCode::FORBIDDEN, "forbidden"),
        Invalid(code) => json_error(StatusCode::BAD_REQUEST, code),
        Internal(msg) => {
            log!("auth: {msg}");
            internal_error()
        }
    }
}

/// readJSON / readOptionalJSON: a strict decode; an empty body is only fine
/// when `optional`.
async fn read_json(req: Req, optional: bool) -> Result<Object, Reject> {
    match first_value(&read_limited(req).await)? {
        Some(v) => Ok(Object::new(v)?),
        None if optional => Ok(Object::new(serde_json::Value::Null)?),
        None => Err(invalid_request().into()),
    }
}

/// Decodes the named string fields of a strict body, rejecting unknown keys.
async fn read_strings<const N: usize>(req: Req, names: [&str; N], optional: bool) -> Result<[Option<String>; N], Reject> {
    let mut o = read_json(req, optional).await?;
    let mut out: [Option<String>; N] = std::array::from_fn(|_| None);
    for (slot, name) in out.iter_mut().zip(names) {
        *slot = o.string(name)?;
    }
    o.finish()?;
    Ok(out)
}

async fn current_user(app: &App, headers: &http::HeaderMap) -> Result<User, Reject> {
    let token = app.auth.cookie_token(headers);
    let svc = app.auth.clone();
    Ok(blocking(move || svc.current_user(&token)).await?)
}

fn session_meta(app: &App, req: &Req, peer: SocketAddr) -> SessionMeta {
    let mut user_agent = req.headers().get(header::USER_AGENT).map(|v| v.as_bytes().to_vec()).unwrap_or_default();
    user_agent.truncate(256);
    SessionMeta { user_agent, ip_hash: sha2::Sha256::digest(app.client_ip(req, peer).as_bytes()).to_vec() }
}

fn with_cookie(mut r: Resp, cookie: &str) -> Resp {
    if let Ok(v) = HeaderValue::from_str(cookie) {
        r.headers_mut().append(header::SET_COOKIE, v);
    }
    r
}

fn session_response(status: StatusCode, user: User) -> Resp {
    json_resp(status, &One("user", &user))
}

pub async fn auth_me(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    Ok(session_response(StatusCode::OK, user))
}

pub async fn auth_register(app: &App, req: Req, peer: SocketAddr) -> Handled {
    let meta = session_meta(app, &req, peer);
    let [invite, username, password] =
        read_strings(req, ["inviteToken", "username", "password"], false).await?.map(Option::unwrap_or_default);
    let svc = app.auth.clone();
    let (token, user) = blocking(move || svc.register_with_invite(&meta, &invite, &username, &password)).await?;
    Ok(with_cookie(session_response(StatusCode::CREATED, user), &app.auth.session_cookie(&token)))
}

pub async fn auth_login(app: &App, req: Req, peer: SocketAddr) -> Handled {
    let meta = session_meta(app, &req, peer);
    let [username, password] = read_strings(req, ["username", "password"], false).await?.map(Option::unwrap_or_default);
    let svc = app.auth.clone();
    let (token, user) = blocking(move || svc.login(&meta, &username, &password)).await?;
    Ok(with_cookie(session_response(StatusCode::OK, user), &app.auth.session_cookie(&token)))
}

pub async fn auth_logout(app: &App, req: Req) -> Handled {
    let token = app.auth.cookie_token(req.headers());
    let svc = app.auth.clone();
    blocking(move || svc.logout(&token)).await.map_err(|e| logged_internal("auth logout", e))?;
    Ok(with_cookie(no_content(), &app.auth.clear_cookie()))
}

pub async fn account_update(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let [username, name] = read_strings(req, ["username", "name"], false).await?;
    let svc = app.auth.clone();
    let user = blocking(move || svc.update_account(&user.id, username.as_deref(), name.as_deref())).await?;
    Ok(session_response(StatusCode::OK, user))
}

pub async fn account_change_password(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let [current, new] = read_strings(req, ["currentPassword", "newPassword"], false).await?.map(Option::unwrap_or_default);
    let svc = app.auth.clone();
    blocking(move || svc.change_password(&user.id, &current, &new)).await?;
    Ok(no_content())
}

pub async fn invite_create(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    // The body is optional and best-effort: a plain create sends none, admins
    // may pre-fill {canInvite, adminNote}. Decode errors are ignored and
    // fields that did decode are kept, like Go's ignored Decode error.
    let body = read_limited(req).await;
    let (mut can_invite, mut note) = (false, String::new());
    if let Some(mut o) = first_value(&body).ok().flatten().and_then(|v| Object::new(v).ok()) {
        can_invite = o.bool("canInvite").ok().flatten().unwrap_or(false);
        note = o.string("adminNote").ok().flatten().unwrap_or_default();
    }
    let svc = app.auth.clone();
    let mut invite = blocking(move || svc.create_invite(&user.id, can_invite, &note)).await?;
    invite.url = format!("/?invite={}", invite.token);
    Ok(json_resp(StatusCode::CREATED, &One("invite", &invite)))
}

pub async fn invites_list(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let svc = app.auth.clone();
    let invites = blocking(move || svc.list_active_invites(&user.id)).await?;
    Ok(json_resp(StatusCode::OK, &One("invites", &invites)))
}

pub async fn invite_delete(app: &App, req: Req, id: String) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let svc = app.auth.clone();
    blocking(move || svc.delete_invite(&user.id, &id)).await?;
    Ok(no_content())
}

/// Trimmed and capped at 64 characters, the frontend's input limit.
fn clamp_name(name: &str) -> String {
    let name = name.trim();
    if name.chars().count() > 64 { name.chars().take(64).collect::<String>().trim().to_string() } else { name.to_string() }
}

fn room_not_found() -> Resp {
    json_error(StatusCode::NOT_FOUND, "room_not_found")
}

pub async fn room_create(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let [name] = read_strings(req, ["name"], true).await?.map(Option::unwrap_or_default);
    let rooms = app.rooms.clone();
    let room = blocking(move || rooms.create(&user.id, &clamp_name(&name))).await.map_err(|e| logged_internal("rooms create", e))?;
    Ok(json_resp(StatusCode::CREATED, &One("room", &room)))
}

pub async fn room_update(app: &App, req: Req, slug: String) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let [name] = read_strings(req, ["name"], false).await?.map(Option::unwrap_or_default);
    let name = clamp_name(&name);
    if name.is_empty() {
        return Ok(json_error(StatusCode::BAD_REQUEST, "invalid_name"));
    }
    let rooms = app.rooms.clone();
    match blocking(move || rooms.rename(&user.id, &slug, &name)).await {
        Ok(()) => Ok(no_content()),
        Err(rooms::Error::NotFound) => Ok(room_not_found()),
        Err(e) => Err(logged_internal("rooms rename", e)),
    }
}

pub async fn rooms_list(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let rooms = app.rooms.clone();
    let list = blocking(move || rooms.list_by_creator(&user.id)).await.map_err(|e| logged_internal("rooms list", e))?;
    Ok(json_resp(StatusCode::OK, &One("rooms", &list)))
}

pub async fn rooms_joined(app: &App, req: Req) -> Handled {
    let user = current_user(app, req.headers()).await?;
    let rooms = app.rooms.clone();
    let list = blocking(move || rooms.list_joined(&user.id)).await.map_err(|e| logged_internal("rooms joined", e))?;
    Ok(json_resp(StatusCode::OK, &One("rooms", &list)))
}

/// No auth: a guest opening a link sees the room's name. Expired and ended
/// links 404 like missing ones.
pub async fn room_get(app: &App, slug: String) -> Handled {
    let rooms = app.rooms.clone();
    match blocking(move || rooms.get(&slug)).await {
        Ok(room) if room.joinable => Ok(json_resp(StatusCode::OK, &One("room", &room))),
        Ok(_) | Err(rooms::Error::NotFound) => Ok(room_not_found()),
        Err(e) => Err(logged_internal("rooms get", e)),
    }
}

async fn require_admin(app: &App, headers: &http::HeaderMap) -> Result<(), Reject> {
    if !current_user(app, headers).await?.is_admin {
        return Err(json_error(StatusCode::FORBIDDEN, "forbidden").into());
    }
    Ok(())
}

pub async fn admin_users_list(app: &App, req: Req) -> Handled {
    require_admin(app, req.headers()).await?;
    let svc = app.auth.clone();
    let users = blocking(move || svc.list_users()).await.map_err(|e| logged_internal("admin users list", e))?;
    Ok(json_resp(StatusCode::OK, &One("users", &users)))
}

pub async fn admin_user_update(app: &App, req: Req, id: String) -> Handled {
    require_admin(app, req.headers()).await?;
    let mut o = read_json(req, false).await?;
    let can_invite = o.bool("canInvite")?;
    let note = o.string("adminNote")?;
    o.finish()?;
    if can_invite.is_none() && note.is_none() {
        return Err(invalid_request().into());
    }
    let svc = app.auth.clone();
    blocking(move || svc.admin_update_user(&id, can_invite, note.as_deref())).await?;
    Ok(no_content())
}

pub async fn admin_user_delete(app: &App, req: Req, id: String) -> Handled {
    require_admin(app, req.headers()).await?;
    let svc = app.auth.clone();
    blocking(move || svc.admin_delete_user(&id)).await?;
    Ok(no_content())
}

/// STUN plus short-lived TURN credentials. No auth: guests joining by link
/// need ICE config too; the slug is the access control.
pub fn ice_config(app: &App) -> Resp {
    #[derive(serde::Serialize)]
    struct IceServer<'a> {
        urls: [&'a str; 1],
        #[serde(skip_serializing_if = "String::is_empty")]
        username: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        credential: String,
    }
    #[derive(serde::Serialize)]
    struct IceConfig<'a> {
        #[serde(rename = "iceServers")]
        ice_servers: Vec<IceServer<'a>>,
    }
    let mut servers = Vec::new();
    if !app.stun_url.is_empty() {
        servers.push(IceServer { urls: [&app.stun_url], username: String::new(), credential: String::new() });
    }
    if !app.turn_url.is_empty() && !app.turn_secret.is_empty() {
        // TURN REST API: the username carries its expiry, the credential is
        // HMAC'd from it with the shared secret.
        let username = format!("{}:guest", util::unix_secs(SystemTime::now() + TURN_CREDS_TTL));
        let credential = turn::credential(&app.turn_secret, &username);
        servers.push(IceServer { urls: [&app.turn_url], username, credential });
    }
    json_resp(StatusCode::OK, &IceConfig { ice_servers: servers })
}

/// No account needed: the unguessable slug is the access control. A valid
/// session cookie records the join in the user's "joined" list.
pub async fn serve_ws(app: &App, mut req: Req, slug: String) -> Handled {
    let user = current_user(app, req.headers()).await.ok();
    let rooms = app.rooms.clone();
    let s = slug.clone();
    let joinable = blocking(move || {
        let ok = rooms.joinable(&s) == Ok(true);
        if let (true, Some(u)) = (ok, &user) {
            rooms.record_join(&s, &u.id);
        }
        ok
    })
    .await;
    if !joinable {
        return Ok(error(StatusCode::FORBIDDEN, "room not available"));
    }
    let rooms = app.rooms.clone();
    let room = blocking(move || rooms.acquire(&slug)).await;
    if room.is_closed() {
        return Ok(error(StatusCode::SERVICE_UNAVAILABLE, "shutting down"));
    }
    let (resp, on_upgrade) = ws::accept(&mut req, &room.origin_patterns()).map_err(|r| {
        log!("sfu: ws accept: rejected handshake ({})", r.status());
        Reject(r)
    })?;
    let cancel = app.shutdown.child_token();
    tokio::spawn(async move {
        let Some(socket) = ws::upgraded(on_upgrade).await else { return };
        Arc::clone(&room).serve_ws(socket, cancel).await;
    });
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp() {
        assert_eq!(clamp_name("  a  "), "a");
        assert_eq!(clamp_name(&"я".repeat(70)), "я".repeat(64));
        assert_eq!(clamp_name(&format!("{} b", "x".repeat(63))), "x".repeat(63));
    }

    #[test]
    fn call_status_body() {
        assert_eq!(call_status(false).status(), StatusCode::OK);
        assert_eq!(call_status(true).headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    }
}
