//! Invite-only account registration, password login and cookie-backed
//! sessions over SQLite. Methods block (argon2, database): async callers run
//! them through `spawn_blocking`.

pub mod password;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::{self, Db, timestamp};
use crate::ratelimit::{Lockout, LockoutConfig};
use crate::util::{b64_raw_url, random_bytes, uuid_v4};
pub use password::PasswordParams;
use password::{hash_password, validate_password, verify_password};

pub const COOKIE_NAME: &str = "sh_session";
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const INVITE_TTL: Duration = Duration::from_secs(7 * 24 * 3600);

// After this many consecutive failed logins for one username, attempts are
// blocked for a back-off doubling from base to max.
const LOGIN_FAIL_THRESHOLD: u32 = 8;
const LOGIN_LOCK_BASE: Duration = Duration::from_secs(60);
const LOGIN_LOCK_MAX: Duration = Duration::from_secs(15 * 60);
/// last_used_at is refreshed at most this often: SQLite is a single writer.
const SESSION_TOUCH_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Default)]
pub struct Config {
    pub cookie_secure: bool,
    pub password_params: PasswordParams,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidCredentials,
    NotAuthenticated,
    UsernameTaken,
    InvalidInvite,
    InviteRequired,
    Forbidden,
    /// Too many failed logins; retry after this long.
    Locked(Duration),
    /// A rejected input: invalid_username, invalid_password, invalid_name, invalid_note.
    Invalid(&'static str),
    Internal(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Error::InvalidCredentials => "invalid_credentials",
            Error::NotAuthenticated => "not_authenticated",
            Error::UsernameTaken => "username_taken",
            Error::InvalidInvite => "invalid_invite",
            Error::InviteRequired => "invite_required",
            Error::Forbidden => "forbidden_auth",
            Error::Locked(_) => "account_locked",
            Error::Invalid(code) => code,
            Error::Internal(msg) => msg,
        })
    }
}

fn internal(ctx: &str) -> impl FnOnce(rusqlite::Error) -> Error + '_ {
    move |e| Error::Internal(format!("{ctx}: {e}"))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub name: String,
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    #[serde(rename = "canInvite")]
    pub can_invite: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Invite {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "usedAt")]
    pub used_at: Option<String>,
}

/// Admin-only projection of an account: the private note and activity times.
#[derive(Clone, Debug, Serialize)]
pub struct AdminUserView {
    pub id: String,
    pub username: String,
    pub name: String,
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    #[serde(rename = "canInvite")]
    pub can_invite: bool,
    #[serde(rename = "adminNote")]
    pub admin_note: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastSeenAt")]
    pub last_seen_at: String,
}

/// Device/network fingerprint stored with a session. Empty fields are NULL.
#[derive(Clone, Debug, Default)]
pub struct SessionMeta {
    /// Raw header bytes, like Go's r.UserAgent(), truncated to 256.
    pub user_agent: Vec<u8>,
    pub ip_hash: Vec<u8>,
}

impl SessionMeta {
    fn user_agent(&self) -> Option<ToSqlOutput<'_>> {
        (!self.user_agent.is_empty()).then(|| ToSqlOutput::Borrowed(ValueRef::Text(&self.user_agent)))
    }

    fn ip_hash(&self) -> Option<&[u8]> {
        (!self.ip_hash.is_empty()).then_some(self.ip_hash.as_slice())
    }
}

pub struct Service {
    db: Arc<Db>,
    cfg: Config,
    lockout: Lockout,
    /// Verified for unknown usernames so they cost the same argon2 time as a
    /// real one: no timing oracle for username enumeration.
    dummy_hash: String,
}

impl Service {
    pub fn new(db: Arc<Db>, cfg: Config) -> Service {
        let dummy_hash = hash_password("timing-equalizer", cfg.password_params).unwrap_or_default();
        Service { db, cfg, lockout: Lockout::new(LockoutConfig::new(LOGIN_FAIL_THRESHOLD, LOGIN_LOCK_BASE, LOGIN_LOCK_MAX)), dummy_hash }
    }

    pub fn register_with_invite(
        &self,
        meta: &SessionMeta,
        invite_token: &str,
        username: &str,
        password: &str,
    ) -> Result<(String, User), Error> {
        if invite_token.is_empty() {
            return Err(Error::InviteRequired);
        }
        let invite_hash = Sha256::digest(invite_token.as_bytes());
        let username = normalize_username(username)?;
        validate_password(password).map_err(Error::Invalid)?;
        let password_hash = hash_password(password, self.cfg.password_params).map_err(Error::Internal)?;
        let user_id = uuid_v4();
        let (token, token_hash) = new_opaque_token();
        let expires_at = timestamp(SystemTime::now() + SESSION_TTL);

        self.db.with(|conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(internal("begin register"))?;
            let now = timestamp(SystemTime::now());
            // Consume the invite and read what it grants in one atomic step.
            let (grant, note): (i64, String) = tx
                .query_row(
                    "update account_invites
			set used_at = ?
			where token_hash = ?
			  and used_at is null
			  and expires_at > ?
			returning grant_can_invite, admin_note",
                    params![now, &invite_hash[..], now],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(internal("consume invite"))?
                .ok_or(Error::InvalidInvite)?;
            let can_invite = grant == 1;
            tx.execute(
                "insert into users (id, username, name, password_hash, can_invite, admin_note) values (?, ?, ?, ?, ?, ?)",
                params![user_id, username, username, password_hash, can_invite, note],
            )
            .map_err(|e| if db::is_unique_violation(&e) { Error::UsernameTaken } else { Error::Internal(format!("insert user: {e}")) })?;
            insert_session(&tx, &user_id, &token_hash, meta, &expires_at)?;
            tx.commit().map_err(internal("commit register"))?;
            Ok((token, User { id: user_id.clone(), username: username.clone(), name: username.clone(), is_admin: false, can_invite }))
        })
    }

    /// Mints a one-time registration token. An empty inviter is only allowed
    /// to bootstrap the first account, while no users exist. Only the admin
    /// may pre-grant invite rights or attach a note.
    pub fn create_invite(&self, inviter_id: &str, grant_can_invite: bool, admin_note: &str) -> Result<Invite, Error> {
        self.db.with(|conn| {
            let mut is_admin = false;
            if inviter_id.is_empty() {
                let count: i64 = conn.query_row("select count(*) from users", [], |r| r.get(0)).map_err(internal("count users"))?;
                if count != 0 {
                    return Err(Error::Forbidden);
                }
            } else {
                let inviter = user_by_id(conn, inviter_id).map_err(|_| Error::Forbidden)?;
                if !inviter.can_invite && !inviter.is_admin {
                    return Err(Error::Forbidden);
                }
                is_admin = inviter.is_admin;
            }
            let (grant, note) = if is_admin { (grant_can_invite, admin_note) } else { (false, "") };
            let note = normalize_admin_note(note)?;
            let (token, token_hash) = new_opaque_token();
            let id = uuid_v4();
            let expires_at = timestamp(SystemTime::now() + INVITE_TTL);
            let invited_by = (!inviter_id.is_empty()).then_some(inviter_id);
            conn.execute(
                "insert into account_invites (id, token_hash, invited_by, expires_at, grant_can_invite, admin_note)
		values (?, ?, ?, ?, ?, ?)",
                params![id, &token_hash[..], invited_by, expires_at, grant, note],
            )
            .map_err(internal("insert invite"))?;
            Ok(Invite { id, token, url: String::new(), expires_at, used_at: None })
        })
    }

    pub fn list_active_invites(&self, inviter_id: &str) -> Result<Vec<Invite>, Error> {
        self.db.with(|conn| {
            user_by_id(conn, inviter_id).map_err(|_| Error::Forbidden)?;
            let now = timestamp(SystemTime::now());
            let mut stmt = conn
                .prepare(
                    "select id, expires_at, used_at
		from account_invites
		where invited_by = ?
		  and used_at is null
		  and expires_at > ?
		order by created_at desc",
                )
                .map_err(internal("select active invites"))?;
            let rows = stmt
                .query_map(params![inviter_id, now], |r| {
                    Ok(Invite { id: r.get(0)?, expires_at: r.get(1)?, used_at: r.get(2)?, ..Invite::default() })
                })
                .map_err(internal("select active invites"))?;
            rows.collect::<Result<_, _>>().map_err(internal("scan invite"))
        })
    }

    pub fn delete_invite(&self, inviter_id: &str, invite_id: &str) -> Result<(), Error> {
        if inviter_id.is_empty() || invite_id.is_empty() {
            return Err(Error::Forbidden);
        }
        let n = self
            .db
            .with(|c| {
                c.execute(
                    "delete from account_invites
		where id = ?
		  and invited_by = ?
		  and used_at is null",
                    params![invite_id, inviter_id],
                )
            })
            .map_err(internal("delete invite"))?;
        if n == 0 { Err(Error::Forbidden) } else { Ok(()) }
    }

    /// Every account, with the admin's note, registration time and last seen
    /// (latest non-revoked session activity).
    pub fn list_users(&self) -> Result<Vec<AdminUserView>, Error> {
        self.db.with(|conn| {
            let mut stmt = conn
                .prepare(
                    "select u.id, u.username, u.name, u.is_admin, u.can_invite, u.admin_note, u.created_at,
		       (select max(coalesce(sx.last_used_at, sx.created_at))
		          from sessions sx where sx.user_id = u.id and sx.revoked_at is null)
		from users u
		order by u.username collate nocase",
                )
                .map_err(internal("list users"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(AdminUserView {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        name: r.get(2)?,
                        is_admin: r.get(3)?,
                        can_invite: r.get(4)?,
                        admin_note: r.get(5)?,
                        created_at: r.get(6)?,
                        last_seen_at: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
                    })
                })
                .map_err(internal("list users"))?;
            rows.collect::<Result<_, _>>().map_err(internal("scan user"))
        })
    }

    /// Sets invite permission and/or the admin's note; `None` leaves a field.
    pub fn admin_update_user(&self, user_id: &str, can_invite: Option<bool>, admin_note: Option<&str>) -> Result<(), Error> {
        if user_id.is_empty() {
            return Err(Error::Forbidden);
        }
        let now = timestamp(SystemTime::now());
        self.db.with(|conn| {
            if let Some(v) = can_invite {
                conn.execute("update users set can_invite = ?, updated_at = ? where id = ?", params![v, now, user_id])
                    .map_err(internal("set can_invite"))?;
            }
            if let Some(note) = admin_note {
                let note = normalize_admin_note(note)?;
                conn.execute("update users set admin_note = ?, updated_at = ? where id = ?", params![note, now, user_id])
                    .map_err(internal("set admin_note"))?;
            }
            Ok(())
        })
    }

    /// Deletes an account. The administrator can never be deleted (which also
    /// blocks self-deletion); owned rows cascade, minted invites lose their
    /// inviter.
    pub fn admin_delete_user(&self, user_id: &str) -> Result<(), Error> {
        let n =
            self.db.with(|c| c.execute("delete from users where id = ? and is_admin = 0", [user_id])).map_err(internal("delete user"))?;
        if n == 0 { Err(Error::Forbidden) } else { Ok(()) }
    }

    fn fail_login(&self, username: &str) -> Error {
        match self.lockout.fail(username) {
            d if d.is_zero() => Error::InvalidCredentials,
            d => Error::Locked(d),
        }
    }

    pub fn login(&self, meta: &SessionMeta, username: &str, password: &str) -> Result<(String, User), Error> {
        let username = normalize_username(username).map_err(|_| Error::InvalidCredentials)?;
        let wait = self.lockout.retry(&username);
        if !wait.is_zero() {
            return Err(Error::Locked(wait));
        }
        let row = self
            .db
            .with(|c| {
                c.query_row(
                    "select id, password_hash, name, is_admin, can_invite from users where username = ? collate nocase and disabled_at is null",
                    [&username],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get(3)?, r.get(4)?)),
                )
                .optional()
            })
            .map_err(internal("select user credentials"))?;
        let Some((id, hash, name, is_admin, can_invite)) = row else {
            let _ = verify_password(password, &self.dummy_hash);
            return Err(self.fail_login(&username));
        };
        if verify_password(password, &hash) != Ok(true) {
            return Err(self.fail_login(&username));
        }
        self.lockout.reset(&username);
        let (token, token_hash) = new_opaque_token();
        let expires_at = timestamp(SystemTime::now() + SESSION_TTL);
        self.db.with(|c| insert_session(c, &id, &token_hash, meta, &expires_at))?;
        Ok((token, User { id, username, name, is_admin, can_invite }))
    }

    /// Changes the display name and/or username; `None` leaves a field.
    pub fn update_account(&self, user_id: &str, username: Option<&str>, name: Option<&str>) -> Result<User, Error> {
        if user_id.is_empty() {
            return Err(Error::Forbidden);
        }
        let now = timestamp(SystemTime::now());
        self.db.with(|conn| {
            if let Some(name) = name {
                let name = validate_display_name(name)?;
                conn.execute("update users set name = ?, updated_at = ? where id = ?", params![name, now, user_id])
                    .map_err(internal("update name"))?;
            }
            if let Some(username) = username {
                let username = normalize_username(username)?;
                conn.execute("update users set username = ?, updated_at = ? where id = ?", params![username, now, user_id]).map_err(
                    |e| if db::is_unique_violation(&e) { Error::UsernameTaken } else { Error::Internal(format!("update username: {e}")) },
                )?;
            }
            user_by_id(conn, user_id).map_err(internal("select user"))
        })
    }

    pub fn change_password(&self, user_id: &str, current: &str, new: &str) -> Result<(), Error> {
        if user_id.is_empty() {
            return Err(Error::Forbidden);
        }
        let hash: String = self
            .db
            .with(|c| {
                c.query_row("select password_hash from users where id = ? and disabled_at is null", [user_id], |r| r.get(0)).optional()
            })
            .map_err(internal("select password"))?
            .ok_or(Error::Forbidden)?;
        if !verify_password(current, &hash).map_err(|e| Error::Internal(format!("verify password: {e}")))? {
            return Err(Error::InvalidCredentials);
        }
        validate_password(new).map_err(Error::Invalid)?;
        let new_hash = hash_password(new, self.cfg.password_params).map_err(|e| Error::Internal(format!("hash password: {e}")))?;
        let now = timestamp(SystemTime::now());
        self.db
            .with(|c| c.execute("update users set password_hash = ?, updated_at = ? where id = ?", params![new_hash, now, user_id]))
            .map_err(internal("update password"))?;
        Ok(())
    }

    pub fn current_user(&self, token: &str) -> Result<User, Error> {
        if token.is_empty() {
            return Err(Error::NotAuthenticated);
        }
        let token_hash = Sha256::digest(token.as_bytes());
        let now = SystemTime::now();
        self.db.with(|c| {
            let row = c
                .query_row(
                    "select users.id, users.username, users.name, users.is_admin, users.can_invite, sessions.id, sessions.last_used_at
		from sessions
		join users on users.id = sessions.user_id
		where sessions.token_hash = ?
		  and sessions.revoked_at is null
		  and sessions.expires_at > ?
		  and users.disabled_at is null",
                    params![&token_hash[..], timestamp(now)],
                    |r| {
                        let user = User { id: r.get(0)?, username: r.get(1)?, name: r.get(2)?, is_admin: r.get(3)?, can_invite: r.get(4)? };
                        Ok((user, r.get::<_, String>(5)?, r.get::<_, Option<String>>(6)?))
                    },
                )
                .optional()
                .map_err(internal("select current user"))?;
            let (user, session_id, last_used) = row.ok_or(Error::NotAuthenticated)?;
            let fresh = last_used
                .and_then(|s| db::parse_timestamp(&s))
                .is_some_and(|prev| now.duration_since(prev).unwrap_or_default() < SESSION_TOUCH_INTERVAL);
            if !fresh {
                let _ = c.execute("update sessions set last_used_at = ? where id = ?", params![timestamp(now), session_id]);
            }
            Ok(user)
        })
    }

    pub fn logout(&self, token: &str) -> Result<(), Error> {
        if token.is_empty() {
            return Ok(());
        }
        let token_hash = Sha256::digest(token.as_bytes());
        self.db
            .with(|c| {
                c.execute(
                    "update sessions set revoked_at = ? where token_hash = ? and revoked_at is null",
                    params![timestamp(SystemTime::now()), &token_hash[..]],
                )
            })
            .map_err(internal("revoke session"))?;
        Ok(())
    }

    /// `Set-Cookie` value for a fresh session, as Go's http.Cookie renders it.
    pub fn session_cookie(&self, token: &str) -> String {
        let expires = http_date(SystemTime::now() + SESSION_TTL);
        self.cookie(token, &expires, &format!("Max-Age={}", SESSION_TTL.as_secs()))
    }

    pub fn clear_cookie(&self) -> String {
        self.cookie("", &http_date(UNIX_EPOCH), "Max-Age=0")
    }

    fn cookie(&self, value: &str, expires: &str, max_age: &str) -> String {
        let secure = if self.cfg.cookie_secure { "; Secure" } else { "" };
        format!("{COOKIE_NAME}={value}; Path=/; Expires={expires}; {max_age}; HttpOnly{secure}; SameSite=Lax")
    }

    /// The session cookie's value, or "" (like Go's r.Cookie).
    pub fn cookie_token(&self, headers: &http::HeaderMap) -> String {
        cookie_value(headers, COOKIE_NAME).unwrap_or_default()
    }
}

fn insert_session(c: &rusqlite::Connection, user_id: &str, token_hash: &[u8], meta: &SessionMeta, expires_at: &str) -> Result<(), Error> {
    c.execute(
        "insert into sessions (id, user_id, token_hash, user_agent, ip_hash, expires_at) values (?, ?, ?, ?, ?, ?)",
        params![uuid_v4(), user_id, token_hash, meta.user_agent(), meta.ip_hash(), expires_at],
    )
    .map_err(internal("insert session"))?;
    Ok(())
}

fn user_by_id(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<User> {
    c.query_row("select id, username, name, is_admin, can_invite from users where id = ? and disabled_at is null", [id], |r| {
        Ok(User { id: r.get(0)?, username: r.get(1)?, name: r.get(2)?, is_admin: r.get(3)?, can_invite: r.get(4)? })
    })
}

/// 32 random bytes, base64url; only its SHA-256 is stored.
fn new_opaque_token() -> (String, [u8; 32]) {
    let token = b64_raw_url(&random_bytes::<32>());
    let hash = Sha256::digest(token.as_bytes()).into();
    (token, hash)
}

/// Trimmed, 1..=64 bytes of printable ASCII without spaces.
pub fn normalize_username(username: &str) -> Result<String, Error> {
    let u = username.trim();
    if u.is_empty() || u.len() > 64 || !u.bytes().all(|b| (b'!'..=b'~').contains(&b)) {
        return Err(Error::Invalid("invalid_username"));
    }
    Ok(u.to_string())
}

fn validate_display_name(name: &str) -> Result<String, Error> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 64 || n.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return Err(Error::Invalid("invalid_name"));
    }
    Ok(n.to_string())
}

fn normalize_admin_note(note: &str) -> Result<String, Error> {
    let n = note.trim();
    if n.chars().count() > 100 {
        return Err(Error::Invalid("invalid_note"));
    }
    Ok(n.to_string())
}

/// Go's http.TimeFormat.
fn http_date(t: SystemTime) -> String {
    let fmt = time::macros::format_description!("[weekday repr:short], [day] [month repr:short] [year] [hour]:[minute]:[second] GMT");
    time::OffsetDateTime::from(t).format(&fmt).expect("formattable")
}

/// First valid `name=value` across Cookie headers, as Go's readCookies parses
/// them: surrounding quotes stripped, values with invalid bytes skipped.
fn cookie_value(headers: &http::HeaderMap, name: &str) -> Option<String> {
    headers.get_all(http::header::COOKIE).iter().flat_map(|v| v.as_bytes().split(|&b| b == b';')).find_map(|part| {
        let part = part.trim_ascii();
        let eq = part.iter().position(|&b| b == b'=').unwrap_or(part.len());
        if part[..eq].trim_ascii() != name.as_bytes() {
            return None;
        }
        let mut v = part.get(eq + 1..).unwrap_or(b"");
        if v.len() > 1 && v[0] == b'"' && v[v.len() - 1] == b'"' {
            v = &v[1..v.len() - 1];
        }
        let valid = v.iter().all(|&b| (0x20..0x7f).contains(&b) && b != b'"' && b != b';' && b != b'\\');
        valid.then(|| String::from_utf8_lossy(v).into_owned())
    })
}
