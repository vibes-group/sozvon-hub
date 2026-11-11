use super::*;
use crate::testkit::{TempDir, fast_params, temp_db};

fn service() -> (Service, Arc<Db>, TempDir) {
    let (db, dir) = temp_db();
    (Service::new(db.clone(), Config { password_params: fast_params(), ..Config::default() }), db, dir)
}

fn exec(db: &Db, sql: &str, args: impl rusqlite::Params) {
    db.with(|c| c.execute(sql, args)).unwrap();
}

fn make_admin(db: &Db, id: &str) {
    exec(db, "update users set is_admin = 1 where id = ?", [id]);
}

fn grant_can_invite(db: &Db, id: &str) {
    exec(db, "update users set can_invite = 1 where id = ?", [id]);
}

fn none() -> SessionMeta {
    SessionMeta::default()
}

fn bootstrap(svc: &Service, username: &str) -> (String, User) {
    let invite = svc.create_invite("", false, "").unwrap();
    svc.register_with_invite(&none(), &invite.token, username, "password123").unwrap()
}

fn register(svc: &Service, inviter: &str, grant: bool, note: &str, username: &str) -> User {
    let invite = svc.create_invite(inviter, grant, note).unwrap();
    svc.register_with_invite(&none(), &invite.token, username, "password123").unwrap().1
}

fn find(users: &[AdminUserView], username: &str) -> AdminUserView {
    users.iter().find(|u| u.username == username).cloned().unwrap_or_else(|| panic!("{username} not in {users:?}"))
}

#[test]
fn create_invite_bootstrap() {
    let (svc, _db, _d) = service();
    let invite = svc.create_invite("", false, "").unwrap();
    assert!(!invite.token.is_empty() && !invite.id.is_empty());
    svc.register_with_invite(&none(), &invite.token, "alice", "password123").unwrap();
    assert_eq!(svc.create_invite("", false, "").unwrap_err(), Error::Forbidden, "bootstrap only while no users exist");
}

#[test]
fn register_with_invite() {
    let (svc, _db, _d) = service();
    let (token, user) = bootstrap(&svc, "alice");
    assert!(!token.is_empty());
    assert_eq!((user.username.as_str(), user.name.as_str()), ("alice", "alice"));
    assert_eq!(svc.current_user(&token).unwrap().id, user.id);
}

#[test]
fn register_stores_session_meta() {
    let (svc, db, _d) = service();
    let invite = svc.create_invite("", false, "").unwrap();
    let meta = SessionMeta { user_agent: b"agent/1".to_vec(), ip_hash: vec![1, 2, 3] };
    svc.register_with_invite(&meta, &invite.token, "alice", "password123").unwrap();
    let (ua, ip): (String, Vec<u8>) =
        db.with(|c| c.query_row("select user_agent, ip_hash from sessions", [], |r| Ok((r.get(0)?, r.get(1)?)))).unwrap();
    assert_eq!((ua.as_str(), ip.as_slice()), ("agent/1", &[1u8, 2, 3][..]));
    svc.login(&none(), "alice", "password123").unwrap();
    let nulls: i64 =
        db.with(|c| c.query_row("select count(*) from sessions where user_agent is null and ip_hash is null", [], |r| r.get(0))).unwrap();
    assert_eq!(nulls, 1);
}

#[test]
fn change_password() {
    let (svc, _db, _d) = service();
    let (_, user) = bootstrap(&svc, "alice");
    assert_eq!(svc.change_password(&user.id, "wrong-password", "newpassword456").unwrap_err(), Error::InvalidCredentials);
    assert_eq!(svc.change_password(&user.id, "password123", "short").unwrap_err(), Error::Invalid("invalid_password"));
    svc.change_password(&user.id, "password123", "newpassword456").unwrap();
    assert_eq!(svc.login(&none(), "alice", "password123").unwrap_err(), Error::InvalidCredentials);
    svc.login(&none(), "alice", "newpassword456").unwrap();
}

#[test]
fn register_invite_errors() {
    let (svc, db, _d) = service();
    assert_eq!(svc.register_with_invite(&none(), "", "alice", "password123").unwrap_err(), Error::InviteRequired);
    assert_eq!(svc.register_with_invite(&none(), "totally-unknown", "alice", "password123").unwrap_err(), Error::InvalidInvite);

    let used = svc.create_invite("", false, "").unwrap();
    let expired = svc.create_invite("", false, "").unwrap();
    let past = timestamp(SystemTime::now() - Duration::from_secs(3600));
    exec(&db, "update account_invites set expires_at = ? where id = ?", [&past, &expired.id]);
    assert_eq!(svc.register_with_invite(&none(), &expired.token, "alice", "password123").unwrap_err(), Error::InvalidInvite);
    svc.register_with_invite(&none(), &used.token, "alice", "password123").unwrap();
    assert_eq!(svc.register_with_invite(&none(), &used.token, "bob", "password123").unwrap_err(), Error::InvalidInvite);
}

#[test]
fn register_username_taken() {
    let (svc, db, _d) = service();
    let (_, user) = bootstrap(&svc, "alice");
    grant_can_invite(&db, &user.id);
    let invite = svc.create_invite(&user.id, false, "").unwrap();
    assert_eq!(svc.register_with_invite(&none(), &invite.token, "ALICE", "password123").unwrap_err(), Error::UsernameTaken);
    // The failed registration left the invite unconsumed.
    svc.register_with_invite(&none(), &invite.token, "bob", "password123").unwrap();
}

#[test]
fn register_invalid_username_and_password() {
    let (svc, _db, _d) = service();
    let i1 = svc.create_invite("", false, "").unwrap();
    assert_eq!(svc.register_with_invite(&none(), &i1.token, "  ", "password123").unwrap_err(), Error::Invalid("invalid_username"));
    let i2 = svc.create_invite("", false, "").unwrap();
    assert_eq!(svc.register_with_invite(&none(), &i2.token, "alice", "short").unwrap_err(), Error::Invalid("invalid_password"));
    let i3 = svc.create_invite("", false, "").unwrap();
    assert_eq!(svc.register_with_invite(&none(), &i3.token, "al ice", "password123").unwrap_err(), Error::Invalid("invalid_username"));
}

#[test]
fn invite_pre_grant_by_admin() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let bob = register(&svc, &admin.id, true, "trusted colleague", "bob");
    assert!(bob.can_invite);
    let b = find(&svc.list_users().unwrap(), "bob");
    assert!(b.can_invite);
    assert_eq!(b.admin_note, "trusted colleague");
}

#[test]
fn invite_pre_grant_ignored_for_non_admin() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let inviter = register(&svc, &admin.id, true, "", "inviter");
    assert!(!inviter.is_admin);
    let bob = register(&svc, &inviter.id, true, "should be dropped", "bob");
    assert!(!bob.can_invite);
    let b = find(&svc.list_users().unwrap(), "bob");
    assert!(!b.can_invite);
    assert_eq!(b.admin_note, "");
}

#[test]
fn create_invite_gating() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let no_perm = register(&svc, &admin.id, false, "", "noperm");
    assert_eq!(svc.create_invite(&no_perm.id, false, "").unwrap_err(), Error::Forbidden);
    let granted = register(&svc, &admin.id, true, "", "granted");
    svc.create_invite(&granted.id, false, "").unwrap();
    svc.admin_update_user(&admin.id, Some(false), None).unwrap();
    svc.create_invite(&admin.id, false, "").expect("admin invites even with can_invite=false");
    assert_eq!(svc.create_invite("missing-user", false, "").unwrap_err(), Error::Forbidden);
}

#[test]
fn invites_list_and_delete() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let a = svc.create_invite(&admin.id, false, "").unwrap();
    let used = svc.create_invite(&admin.id, false, "").unwrap();
    svc.register_with_invite(&none(), &used.token, "bob", "password123").unwrap();
    let listed = svc.list_active_invites(&admin.id).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.as_str(), listed[0].token.as_str(), listed[0].used_at.as_deref()), (a.id.as_str(), "", None));
    assert_eq!(svc.delete_invite(&admin.id, &used.id).unwrap_err(), Error::Forbidden, "used invites stay");
    assert_eq!(svc.delete_invite("someone-else", &a.id).unwrap_err(), Error::Forbidden);
    svc.delete_invite(&admin.id, &a.id).unwrap();
    assert!(svc.list_active_invites(&admin.id).unwrap().is_empty());
    assert_eq!(svc.list_active_invites("missing").unwrap_err(), Error::Forbidden);
}

#[test]
fn login() {
    let (svc, db, _d) = service();
    let (_, user) = bootstrap(&svc, "alice");
    make_admin(&db, &user.id);
    grant_can_invite(&db, &user.id);
    let (token, logged) = svc.login(&none(), "alice", "password123").unwrap();
    assert!(!token.is_empty());
    assert!(logged.name == "alice" && logged.is_admin && logged.can_invite, "{logged:?}");
    // Case-insensitive lookup; the typed username is echoed back like Go did.
    assert_eq!(svc.login(&none(), " ALICE ", "password123").unwrap().1.username, "ALICE");
    assert_eq!(svc.login(&none(), "alice", "wrong-password").unwrap_err(), Error::InvalidCredentials);
    assert_eq!(svc.login(&none(), "nobody", "password123").unwrap_err(), Error::InvalidCredentials);
    assert_eq!(svc.login(&none(), "", "password123").unwrap_err(), Error::InvalidCredentials);
}

#[test]
fn login_lockout() {
    let (svc, _db, _d) = service();
    bootstrap(&svc, "alice");
    for i in 0..LOGIN_FAIL_THRESHOLD - 1 {
        assert_eq!(svc.login(&none(), "alice", "wrong").unwrap_err(), Error::InvalidCredentials, "attempt {i}");
    }
    let Error::Locked(wait) = svc.login(&none(), "alice", "wrong").unwrap_err() else { panic!("expected lock at threshold") };
    assert!(wait > Duration::ZERO);
    assert!(matches!(svc.login(&none(), "alice", "password123").unwrap_err(), Error::Locked(_)), "lockout is checked first");
}

#[test]
fn login_success_resets_lockout() {
    let (svc, _db, _d) = service();
    bootstrap(&svc, "alice");
    for _ in 0..LOGIN_FAIL_THRESHOLD - 1 {
        let _ = svc.login(&none(), "alice", "wrong");
    }
    svc.login(&none(), "alice", "password123").unwrap();
    assert_eq!(svc.login(&none(), "alice", "wrong").unwrap_err(), Error::InvalidCredentials);
}

#[test]
fn current_user_and_logout() {
    let (svc, db, _d) = service();
    let (token, user) = bootstrap(&svc, "alice");
    assert_eq!(svc.current_user("").unwrap_err(), Error::NotAuthenticated);
    assert_eq!(svc.current_user(&token).unwrap().id, user.id);
    let touched: Option<String> = db.with(|c| c.query_row("select last_used_at from sessions", [], |r| r.get(0))).unwrap();
    assert!(touched.as_deref().and_then(db::parse_timestamp).is_some(), "{touched:?}");
    svc.logout(&token).unwrap();
    svc.logout("").unwrap();
    assert_eq!(svc.current_user(&token).unwrap_err(), Error::NotAuthenticated);
}

#[test]
fn current_user_expired_session() {
    let (svc, db, _d) = service();
    let (token, _) = bootstrap(&svc, "alice");
    let past = timestamp(SystemTime::now() - Duration::from_secs(3600));
    exec(&db, "update sessions set expires_at = ?", [&past]);
    assert_eq!(svc.current_user(&token).unwrap_err(), Error::NotAuthenticated);
}

#[test]
fn update_account() {
    let (svc, _db, _d) = service();
    let (_, user) = bootstrap(&svc, "alice");
    assert_eq!(svc.update_account(&user.id, None, Some("Alice Liddell")).unwrap().name, "Alice Liddell");
    assert_eq!(svc.update_account(&user.id, Some("alice2"), None).unwrap().username, "alice2");
    let noop = svc.update_account(&user.id, None, None).unwrap();
    assert_eq!((noop.username.as_str(), noop.name.as_str()), ("alice2", "Alice Liddell"));
}

#[test]
fn update_account_username_collision() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let bob = register(&svc, &admin.id, false, "", "bob");
    assert_eq!(svc.update_account(&bob.id, Some("Admin"), None).unwrap_err(), Error::UsernameTaken);
}

#[test]
fn update_account_invalid_fields() {
    let (svc, _db, _d) = service();
    let (_, user) = bootstrap(&svc, "alice");
    assert_eq!(svc.update_account(&user.id, None, Some("   ")).unwrap_err(), Error::Invalid("invalid_name"));
    assert_eq!(svc.update_account(&user.id, Some("   "), None).unwrap_err(), Error::Invalid("invalid_username"));
    assert_eq!(svc.update_account(&user.id, None, Some("a\u{7f}")).unwrap_err(), Error::Invalid("invalid_name"));
    assert_eq!(svc.update_account(&user.id, None, Some(&"я".repeat(64))).unwrap().name, "я".repeat(64));
    assert_eq!(svc.update_account(&user.id, None, Some(&"я".repeat(65))).unwrap_err(), Error::Invalid("invalid_name"));
}

#[test]
fn list_users_projection() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    register(&svc, &admin.id, true, "the note", "bob");
    svc.login(&none(), "bob", "password123").unwrap();
    let users = svc.list_users().unwrap();
    let a = find(&users, "admin");
    assert!(a.is_admin && !a.created_at.is_empty());
    let b = find(&users, "bob");
    assert!(!b.is_admin && b.can_invite);
    assert_eq!(b.admin_note, "the note");
    assert!(!b.last_seen_at.is_empty());
}

#[test]
fn admin_update_user() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let bob = register(&svc, &admin.id, false, "", "bob");
    svc.admin_update_user(&bob.id, Some(true), None).unwrap();
    assert!(find(&svc.list_users().unwrap(), "bob").can_invite);
    svc.admin_update_user(&bob.id, None, Some("promoted")).unwrap();
    assert_eq!(find(&svc.list_users().unwrap(), "bob").admin_note, "promoted");
    svc.admin_update_user(&bob.id, Some(false), Some("demoted")).unwrap();
    let b = find(&svc.list_users().unwrap(), "bob");
    assert!(!b.can_invite && b.admin_note == "demoted");
    assert_eq!(svc.admin_update_user(&bob.id, None, Some(&"x".repeat(101))).unwrap_err(), Error::Invalid("invalid_note"));
}

#[test]
fn admin_delete_user() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let bob = register(&svc, &admin.id, false, "", "bob");
    assert_eq!(svc.admin_delete_user(&admin.id).unwrap_err(), Error::Forbidden);
    assert_eq!(svc.admin_delete_user("").unwrap_err(), Error::Forbidden);
    assert_eq!(svc.list_users().unwrap().len(), 2);
    svc.admin_delete_user(&bob.id).unwrap();
    let users = svc.list_users().unwrap();
    assert!(users.len() == 1 && users[0].id == admin.id);
    assert_eq!(svc.admin_delete_user(&bob.id).unwrap_err(), Error::Forbidden);
    let sessions: i64 = db.with(|c| c.query_row("select count(*) from sessions where user_id = ?", [&bob.id], |r| r.get(0))).unwrap();
    assert_eq!(sessions, 0, "sessions cascade");
}

#[test]
fn single_admin_constraint() {
    let (svc, db, _d) = service();
    let (_, admin) = bootstrap(&svc, "admin");
    make_admin(&db, &admin.id);
    let bob = register(&svc, &admin.id, false, "", "bob");
    let err = db.with(|c| c.execute("update users set is_admin = 1 where id = ?", [&bob.id])).unwrap_err();
    assert!(db::is_unique_violation(&err), "{err}");
}

#[test]
fn normalize_admin_note_bounds() {
    assert_eq!(normalize_admin_note("  hello  ").unwrap(), "hello");
    assert!(normalize_admin_note(&"x".repeat(100)).is_ok());
    assert!(normalize_admin_note(&"x".repeat(101)).is_err());
}

#[test]
fn cookies_match_go() {
    let svc = Service::new(temp_db().0, Config { cookie_secure: true, password_params: fast_params() });
    let c = svc.session_cookie("tok");
    assert!(c.starts_with("sh_session=tok; Path=/; Expires="), "{c}");
    assert!(c.ends_with(" GMT; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"), "{c}");
    assert_eq!(svc.clear_cookie(), "sh_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax");

    let mut h = http::HeaderMap::new();
    h.append(http::header::COOKIE, "a=1; sh_session=\"q\"".parse().unwrap());
    assert_eq!(svc.cookie_token(&h), "q");
    let mut h = http::HeaderMap::new();
    h.append(http::header::COOKIE, "sh_session=bad\\x; sh_session=good".parse().unwrap());
    assert_eq!(svc.cookie_token(&h), "good");
    assert_eq!(svc.cookie_token(&http::HeaderMap::new()), "");
}
