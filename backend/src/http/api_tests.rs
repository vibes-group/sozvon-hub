//! The HTTP contract, ported from the Go api tests and extended to the
//! uploads, SPA and WebSocket gates.

use std::time::Duration;

use bytes::Bytes;
use http::{Method, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};

use super::Resp;
use crate::filestore;
use crate::testkit::{Env, PASSWORD, env, env_with};

async fn text(r: Resp) -> String {
    String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
}

async fn body(r: Resp) -> Value {
    serde_json::from_str(&text(r).await).unwrap()
}

/// `name=value` of the response's session cookie.
fn session_cookie(r: &Resp) -> String {
    let c = r.headers()[header::SET_COOKIE].to_str().unwrap();
    c.split(';').next().unwrap().to_string()
}

async fn send(e: &Env, method: Method, uri: &str, cookie: Option<&str>, v: Option<Value>) -> Resp {
    let (ct, b) = match v {
        Some(v) => (vec![("content-type", "application/json")], Bytes::from(v.to_string())),
        None => (vec![], Bytes::new()),
    };
    e.call(method, uri, cookie, &ct, b).await
}

async fn status(e: &Env, method: Method, uri: &str, cookie: Option<&str>, v: Option<Value>) -> StatusCode {
    send(e, method, uri, cookie, v).await.status()
}

async fn error_code(r: Resp) -> String {
    body(r).await["error"].as_str().unwrap().to_string()
}

fn exec(e: &Env, sql: &str, id: &str) {
    e.db.with(|c| c.execute(sql, [id])).unwrap();
}

/// Registers over HTTP and returns the session cookie and user id.
async fn register(e: &Env, invite: &str, username: &str) -> (String, String) {
    let r = send(
        e,
        Method::POST,
        "/api/auth/register",
        None,
        Some(json!({ "inviteToken": invite, "username": username, "password": PASSWORD })),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let cookie = session_cookie(&r);
    let v = body(r).await;
    (cookie, v["user"]["id"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn healthz() {
    let e = env().await;
    let r = e.get("/healthz", None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(text(r).await, "ok");
}

#[tokio::test]
async fn auth_flow() {
    let e = env().await;
    // Fresh registration through the HTTP surface.
    e.db.with(|c| c.execute("update users set can_invite = 1", [])).unwrap();
    let invite = e.app.auth.create_invite(&e.user.id, false, "").unwrap();
    let r = send(
        &e,
        Method::POST,
        "/api/auth/register",
        None,
        Some(json!({ "inviteToken": invite.token, "username": "bob", "password": PASSWORD })),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let set = r.headers()[header::SET_COOKIE].to_str().unwrap().to_string();
    assert!(set.starts_with("sh_session=") && set.ends_with("; HttpOnly; SameSite=Lax"), "{set}");
    let cookie = session_cookie(&r);
    let v = body(r).await;
    assert_eq!(v["user"]["username"], "bob");
    assert_eq!(
        v["user"].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["canInvite", "id", "isAdmin", "name", "username"],
        "exactly the Go fields"
    );

    let r = e.get("/api/auth/me", Some(&cookie)).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["user"]["name"], "bob");
    let r = e.get("/api/auth/me", None).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(r).await, "not_authenticated");

    let r = send(&e, Method::POST, "/api/auth/login", None, Some(json!({ "username": "bob", "password": "nope-wrong" }))).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(r).await, "invalid_credentials");
    let r = send(&e, Method::POST, "/api/auth/login", None, Some(json!({ "username": "bob", "password": PASSWORD }))).await;
    assert_eq!(r.status(), StatusCode::OK);
    let login_cookie = session_cookie(&r);

    let r = send(&e, Method::POST, "/api/auth/logout", Some(&cookie), None).await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    assert!(
        r.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .starts_with("sh_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0")
    );
    assert_eq!(e.get("/api/auth/me", Some(&cookie)).await.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(e.get("/api/auth/me", Some(&login_cookie)).await.status(), StatusCode::OK, "other sessions survive");
}

#[tokio::test]
async fn request_validation() {
    let e = env().await;
    let reg = |v: Value| send(&e, Method::POST, "/api/auth/register", None, Some(v));
    assert_eq!(error_code(reg(json!({ "username": "x", "password": PASSWORD })).await).await, "invite_required");
    assert_eq!(error_code(reg(json!({ "inviteToken": "nope", "username": "bob", "password": PASSWORD })).await).await, "invalid_invite");
    assert_eq!(error_code(reg(json!({ "inviteToken": "nope", "username": "bob", "password": "short" })).await).await, "invalid_password");
    assert_eq!(error_code(reg(json!({ "inviteToken": "x", "extra": 1 })).await).await, "invalid_request", "unknown fields");
    assert_eq!(error_code(reg(json!({ "inviteToken": 5 })).await).await, "invalid_request", "wrong type");
    let r = e.call(Method::POST, "/api/auth/register", None, &[], "").await;
    assert_eq!((r.status(), error_code(r).await.as_str()), (StatusCode::BAD_REQUEST, "invalid_request"));
    // Field names match case-insensitively, trailing bytes are ignored.
    let r = e.call(Method::POST, "/api/auth/login", None, &[], r#"{"USERNAME":"alice","Password":"password123"} junk"#).await;
    assert_eq!(r.status(), StatusCode::OK);
    let r = send(&e, Method::PATCH, "/api/account", Some(&e.user_cookie()), Some(json!({ "username": "alice", "name": "  " }))).await;
    assert_eq!((r.status(), error_code(r).await.as_str()), (StatusCode::BAD_REQUEST, "invalid_name"));
}

#[tokio::test]
async fn invites() {
    let e = env().await;
    let c = e.user_cookie();
    let r = send(&e, Method::POST, "/api/invites", Some(&c), Some(json!({}))).await;
    assert_eq!((r.status(), error_code(r).await.as_str()), (StatusCode::FORBIDDEN, "forbidden"));

    exec(&e, "update users set can_invite = 1 where id = ?", &e.user.id);
    let r = e.call(Method::POST, "/api/invites", Some(&c), &[], "").await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let created = body(r).await["invite"].clone();
    let token = created["token"].as_str().unwrap();
    assert_eq!(created["url"], format!("/?invite={token}"));
    assert_eq!(created["usedAt"], Value::Null);

    let r = e.get("/api/invites", Some(&c)).await;
    assert_eq!(r.status(), StatusCode::OK);
    let listed = body(r).await["invites"].as_array().unwrap().clone();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].get("token").is_none() && listed[0].get("url").is_none(), "token shown only at creation");
    let id = listed[0]["id"].as_str().unwrap();

    assert_eq!(status(&e, Method::DELETE, &format!("/api/invites/{id}"), Some(&c), None).await, StatusCode::NO_CONTENT);
    assert_eq!(status(&e, Method::DELETE, &format!("/api/invites/{id}"), Some(&c), None).await, StatusCode::FORBIDDEN);
    assert_eq!(body(e.get("/api/invites", Some(&c)).await).await["invites"], json!([]));
    assert_eq!(status(&e, Method::GET, "/api/invites", None, None).await, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rooms() {
    let e = env().await;
    let c = e.user_cookie();
    assert_eq!(status(&e, Method::POST, "/api/rooms", None, None).await, StatusCode::UNAUTHORIZED);

    let r = e.call(Method::POST, "/api/rooms", Some(&c), &[], "").await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let room = body(r).await["room"].clone();
    let slug = room["slug"].as_str().unwrap().to_string();
    assert_eq!(room["url"], format!("/r/{slug}"));
    assert!(!room["name"].as_str().unwrap().is_empty(), "generated name");
    let named = body(send(&e, Method::POST, "/api/rooms", Some(&c), Some(json!({ "name": "  Planning  " }))).await).await;
    assert_eq!(named["room"]["name"], "Planning");
    assert_eq!(status(&e, Method::POST, "/api/rooms", Some(&c), Some(json!({ "nope": 1 }))).await, StatusCode::BAD_REQUEST);

    let list = body(e.get("/api/rooms", Some(&c)).await).await["rooms"].as_array().unwrap().clone();
    assert_eq!(list.len(), 3, "env room + two");
    assert!(list.iter().any(|r| r["slug"] == slug.as_str() && r["status"] == "pending" && r["participants"] == 0));
    assert!(list.iter().all(|r| r.get("closesAt").is_none()));

    let r = e.get(&format!("/api/rooms/{slug}"), None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["room"], json!({ "slug": slug, "name": room["name"], "joinable": true }));
    let r = e.get("/api/rooms/nope", None).await;
    assert_eq!((r.status(), error_code(r).await.as_str()), (StatusCode::NOT_FOUND, "room_not_found"));

    let rename = |s: &str, v: Value| {
        let (uri, e, c) = (format!("/api/rooms/{s}"), &e, &c);
        async move { send(e, Method::PATCH, &uri, Some(c), Some(v)).await }
    };
    assert_eq!(rename(&slug, json!({ "name": "Renamed" })).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(body(e.get(&format!("/api/rooms/{slug}"), None).await).await["room"]["name"], "Renamed");
    assert_eq!(error_code(rename(&slug, json!({ "name": "   " })).await).await, "invalid_name");
    assert_eq!(error_code(rename("nope", json!({ "name": "x" })).await).await, "room_not_found");

    // Ended links 404 like missing ones.
    exec(&e, "update rooms set status = 'ended' where slug = ?", &slug);
    assert_eq!(e.get(&format!("/api/rooms/{slug}"), None).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(e.get("/api/rooms/joined", Some(&c)).await).await["rooms"], json!([]));
}

#[tokio::test]
async fn ice_config() {
    let e = env().await;
    let r = e.get("/api/config", None).await;
    assert_eq!(r.status(), StatusCode::OK);
    let t = text(r).await;
    assert!(
        t.starts_with(r#"{"iceServers":[{"urls":["stun:stun.example.com:3478"]},{"urls":["turn:turn.example.com:3478"],"username":""#),
        "{t}"
    );
    let v: Value = serde_json::from_str(&t).unwrap();
    let turn = &v["iceServers"][1];
    assert!(turn["username"].as_str().unwrap().ends_with(":guest"));
    assert_eq!(turn["credential"], crate::turn::credential("shared-secret", turn["username"].as_str().unwrap()));
}

#[tokio::test]
async fn admin() {
    let e = env().await;
    let admin = e.user_cookie();
    exec(&e, "update users set is_admin = 1 where id = ?", &e.user.id);
    let invite = e.app.auth.create_invite(&e.user.id, false, "").unwrap();
    let (bob, bob_id) = register(&e, &invite.token, "bob").await;

    assert_eq!(status(&e, Method::GET, "/api/admin/users", Some(&bob), None).await, StatusCode::FORBIDDEN);
    let users = body(e.get("/api/admin/users", Some(&admin)).await).await["users"].as_array().unwrap().clone();
    assert_eq!(users.len(), 2);
    assert_eq!(
        users[0].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["adminNote", "canInvite", "createdAt", "id", "isAdmin", "lastSeenAt", "name", "username"]
    );

    let patch = |who: &str, id: &str, v: Value| {
        let (uri, who, e) = (format!("/api/admin/users/{id}"), who.to_string(), &e);
        async move { send(e, Method::PATCH, &uri, Some(&who), Some(v)).await }
    };
    assert_eq!(patch(&bob, &bob_id, json!({ "canInvite": true })).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(patch(&admin, &bob_id, json!({})).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(patch(&admin, &bob_id, json!({ "canInvite": null })).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(error_code(patch(&admin, &bob_id, json!({ "adminNote": "x".repeat(101) })).await).await, "invalid_note");
    assert_eq!(patch(&admin, &bob_id, json!({ "canInvite": true })).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(status(&e, Method::POST, "/api/invites", Some(&bob), Some(json!({}))).await, StatusCode::CREATED);

    let del = |who: &str, id: &str| {
        let (uri, who, e) = (format!("/api/admin/users/{id}"), who.to_string(), &e);
        async move { status(e, Method::DELETE, &uri, Some(&who), None).await }
    };
    assert_eq!(del(&bob, &e.user.id).await, StatusCode::FORBIDDEN);
    assert_eq!(del(&admin, &e.user.id).await, StatusCode::FORBIDDEN, "the admin can't delete themselves");
    assert_eq!(del(&admin, &bob_id).await, StatusCode::NO_CONTENT);
    assert_eq!(body(e.get("/api/admin/users", Some(&admin)).await).await["users"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn admin_invite_pre_grant() {
    let e = env().await;
    exec(&e, "update users set is_admin = 1 where id = ?", &e.user.id);
    let r = send(&e, Method::POST, "/api/invites", Some(&e.user_cookie()), Some(json!({ "canInvite": true, "adminNote": "friend" }))).await;
    let token = body(r).await["invite"]["token"].as_str().unwrap().to_string();
    let r =
        send(&e, Method::POST, "/api/auth/register", None, Some(json!({ "inviteToken": token, "username": "bob", "password": PASSWORD })))
            .await;
    assert_eq!(body(r).await["user"]["canInvite"], true);
    // Malformed optional bodies are tolerated.
    let r = e.call(Method::POST, "/api/invites", Some(&e.user_cookie()), &[], "{not json").await;
    assert_eq!(r.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn login_rate_limited_by_ip() {
    let e = env().await;
    // A new username each time keeps the per-username lockout out of it.
    let mut last = None;
    for i in 0..50 {
        let r =
            send(&e, Method::POST, "/api/auth/login", None, Some(json!({ "username": format!("ghost{i}"), "password": "whatever" }))).await;
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            assert!(i > 0, "first attempt should not be rate limited");
            last = Some(r);
            break;
        }
    }
    let r = last.expect("rate limited");
    assert!(r.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(error_code(r).await, "rate_limited");
}

#[tokio::test]
async fn login_locked_by_username() {
    let e = env().await;
    let mut last = None;
    for _ in 0..50 {
        let r = send(&e, Method::POST, "/api/auth/login", None, Some(json!({ "username": "alice", "password": "wrong" }))).await;
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            last = Some(r);
            break;
        }
    }
    let r = last.expect("locked");
    assert_eq!(r.headers()[header::RETRY_AFTER], "60");
    assert_eq!(error_code(r).await, "too_many_attempts");
}

#[tokio::test]
async fn account_update_and_password() {
    let e = env().await;
    let c = e.user_cookie();
    let r = send(&e, Method::PATCH, "/api/account", Some(&c), Some(json!({ "name": "Alice L" }))).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["user"]["name"], "Alice L");
    let pw = |cur: &str, new: &str| {
        send(&e, Method::POST, "/api/account/password", Some(&c), Some(json!({ "currentPassword": cur, "newPassword": new })))
    };
    assert_eq!(error_code(pw("wrong", "newpassword1").await).await, "invalid_credentials");
    assert_eq!(pw(PASSWORD, "newpassword1").await.status(), StatusCode::NO_CONTENT);
    let r = send(&e, Method::POST, "/api/auth/login", None, Some(json!({ "username": "alice", "password": "newpassword1" }))).await;
    assert_eq!(r.status(), StatusCode::OK);
}

#[tokio::test]
async fn global_api_rate_limit() {
    let e = env().await;
    let mut hit = None;
    for i in 0..100 {
        let r = e.get("/api/config", None).await;
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            hit = Some((i, r));
            break;
        }
    }
    let (i, r) = hit.expect("limited");
    assert_eq!(i, 60, "burst of 60");
    assert_eq!(error_code(r).await, "rate_limited");
    assert_eq!(e.get("/%61pi/config", None).await.status(), StatusCode::TOO_MANY_REQUESTS, "escaped /api");
    assert_eq!(e.get("/healthz", None).await.status(), StatusCode::OK, "outside /api");
}

#[tokio::test]
async fn session_meta_recorded() {
    let e = env().await;
    let headers = [("content-type", "application/json"), ("user-agent", "agent/2"), ("x-forwarded-for", "203.0.113.9")];
    let r = e.call(Method::POST, "/api/auth/login", None, &headers, json!({ "username": "alice", "password": PASSWORD }).to_string()).await;
    assert_eq!(r.status(), StatusCode::OK);
    let (ua, ip): (String, Vec<u8>) = e
        .db
        .with(|c| c.query_row("select user_agent, ip_hash from sessions where user_agent is not null", [], |r| Ok((r.get(0)?, r.get(1)?))))
        .unwrap();
    use sha2::Digest;
    assert_eq!((ua.as_str(), ip), ("agent/2", sha2::Sha256::digest(b"203.0.113.9").to_vec()), "loopback proxy is trusted by default");
}

#[tokio::test]
async fn upload_and_download() {
    let e = env().await;
    let room = e.room.clone();
    let other = e.new_room();
    assert_eq!(e.call(Method::POST, "/api/upload?room=nope", None, &[], "x").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(e.call(Method::POST, "/api/upload", None, &[], "x").await.status(), StatusCode::NOT_FOUND);
    let too_big = vec![b'a'; (1 << 20) + 2];
    assert_eq!(e.call(Method::POST, &format!("/api/upload?room={room}"), None, &[], too_big).await.status(), StatusCode::PAYLOAD_TOO_LARGE);

    let cd = [(header::CONTENT_DISPOSITION.as_str(), "attachment; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.png")];
    let png = b"\x89PNG\x0D\x0A\x1A\x0A0123456789".to_vec();
    let r = e.call(Method::POST, &format!("/api/upload?room={room}"), None, &cd, png).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let id = body(r).await["uploadId"].as_str().unwrap().to_string();

    assert_eq!(e.get(&format!("/api/file/nope?room={room}"), None).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(e.get(&format!("/api/file/{id}?room={other}"), None).await.status(), StatusCode::NOT_FOUND, "cross-room");
    let r = e.get(&format!("/api/file/{id}?room={room}"), None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(r.headers()[header::CONTENT_DISPOSITION], "inline; filename=\"____.png\"; filename*=UTF-8''%D1%84%D0%BE%D1%82%D0%BE.png");
    let created = e.app.files.get(&id).unwrap().created_at;
    let lm = r.headers()[header::LAST_MODIFIED].to_str().unwrap().to_string();
    let want = time::OffsetDateTime::from(created)
        .format(&time::macros::format_description!("[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT"))
        .unwrap();
    assert_eq!(lm, want, "Last-Modified is the upload time");
    let r = e.call(Method::GET, &format!("/api/file/{id}?room={room}"), None, &[("range", "bytes=8-11")], Bytes::new()).await;
    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(text(r).await, "0123");

    let mp = [(header::CONTENT_TYPE.as_str(), "multipart/form-data; boundary=XX")];
    let mpb = "--XX\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n--XX\r\nContent-Disposition: form-data; name=\"file\"; filename=\"../a.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7 body\r\n--XX--\r\n";
    let r = e.call(Method::POST, &format!("/api/upload?room={room}"), None, &mp, mpb).await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let entry = e.app.files.get(body(r).await["uploadId"].as_str().unwrap()).unwrap();
    assert_eq!((entry.name.as_str(), entry.mime.as_str(), entry.size), ("a.pdf", "application/pdf", 13));

    // Uploads stop once the room is no longer joinable.
    exec(&e, "update rooms set status = 'ended' where slug = ?", &room);
    assert_eq!(e.call(Method::POST, &format!("/api/upload?room={room}"), None, &[], "x").await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upload_budget_and_eviction() {
    let e = env_with(|tmp| filestore::Config {
        temp_dir: tmp,
        ttl: Duration::ZERO,
        ttl_hard_cap: Duration::from_secs(1800),
        max_upload_bytes: 100,
        max_total_bytes: 10,
        janitor_interval: Duration::from_secs(3600),
    })
    .await;
    let up = format!("/api/upload?room={}", e.room);
    let r = e.call(Method::POST, &up, None, &[], "x".repeat(11)).await;
    assert_eq!((r.status(), text(r).await.as_str()), (StatusCode::INSUFFICIENT_STORAGE, "server storage full\n"));
    let id = body(e.call(Method::POST, &up, None, &[], "hello").await).await["uploadId"].as_str().unwrap().to_string();
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(e.get(&format!("/api/file/{id}?room={}", e.room), None).await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn spa() {
    let e = env().await;
    let r = e.get("/", None).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(text(r).await, "<html>app</html>");
    assert_eq!(text(e.get("/r/someslug", None).await).await, "<html>app</html>", "deep links fall back to index.html");
    assert_eq!(text(e.call(Method::POST, "/r/x", None, &[], "").await).await, "<html>app</html>", "any method, like http.ServeFile");
    let r = e.get("/assets/app.js", None).await;
    assert_eq!(r.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
    let r = e.get("/assets/missing.js", None).await;
    assert_eq!((r.status(), text(r).await.as_str()), (StatusCode::NOT_FOUND, "404 page not found\n"));
    let r = e.get("/index.html?x=1", None).await;
    assert_eq!((r.status(), r.headers()[header::LOCATION].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, "./?x=1"));
    let r = e.get("/assets/app.js/", None).await;
    assert_eq!(r.headers()[header::LOCATION], "../app.js");
    let r = e.get("/a/../r", None).await;
    assert_eq!((r.status(), r.headers()[header::LOCATION].to_str().unwrap()), (StatusCode::MOVED_PERMANENTLY, "/r"));
    // Unrouted methods on API paths reach the SPA, like Go's "/" catch-all.
    assert_eq!(e.call(Method::DELETE, "/api/rooms", None, &[], "").await.status(), StatusCode::OK);
}

#[tokio::test]
async fn ws_gate() {
    let e = env().await;
    let ws = |slug: &str| {
        let (uri, e) = (format!("/ws/{slug}"), &e);
        async move { e.call(Method::GET, &uri, None, &[], Bytes::new()).await }
    };
    let r = ws("nope").await;
    assert_eq!((r.status(), text(r).await.as_str()), (StatusCode::FORBIDDEN, "room not available\n"));
    assert_eq!(ws(&e.room).await.status(), StatusCode::UPGRADE_REQUIRED, "plain GET is not a handshake");
    let handshake = [
        ("connection", "Upgrade"),
        ("upgrade", "websocket"),
        ("sec-websocket-version", "13"),
        ("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="),
        ("origin", "https://evil.example"),
    ];
    let r = e.call(Method::GET, &format!("/ws/{}", e.room), None, &handshake, Bytes::new()).await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN, "foreign Origin");
    let ok = &handshake[..4];
    let r = e.call(Method::GET, &format!("/ws/{}", e.room), Some(&e.user_cookie()), ok, Bytes::new()).await;
    assert_eq!(r.status(), StatusCode::SWITCHING_PROTOCOLS, "guests and users alike");
    let joined: i64 = e.db.with(|c| c.query_row("select count(*) from room_participants", [], |r| r.get(0))).unwrap();
    assert_eq!(joined, 1, "a logged-in joiner is recorded");
    assert_eq!(body(e.get(&format!("/api/rooms/{}", e.room), None).await).await["room"]["joinable"], true);
    let status: String = e.db.with(|c| c.query_row("select status from rooms where slug = ?", [&e.room], |r| r.get(0))).unwrap();
    assert_eq!(status, "active");
    assert!(e.live_room(&e.room).is_some());
}

#[tokio::test]
async fn internal_call_status() {
    let e = env().await;
    let call = |m: Method, path: &str| {
        let req = http::Request::builder().method(m).uri(path).body(super::empty()).unwrap();
        super::server::handle_internal(e.app.clone(), req)
    };
    let r = call(Method::GET, "/internal/call-status").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(text(r).await, "idle\n");
    let r = call(Method::POST, "/internal/call-status").await;
    assert_eq!((r.status(), r.headers()[header::ALLOW].to_str().unwrap()), (StatusCode::METHOD_NOT_ALLOWED, "GET, HEAD"));
    assert_eq!(call(Method::GET, "/internal/other").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(call(Method::GET, "/api/config").await.status(), StatusCode::NOT_FOUND, "public routes stay off the internal port");
}
