// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Credentials, login sessions, API keys and login bans (AGENTS.md 4.10).
//! Passwords are stored as argon2 hashes, API keys as SHA-256 hashes; neither
//! is ever kept in plain text.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::util::{hex, now, random_bytes};

/// Stored credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials {
    /// Login name.
    pub username: String,
    /// argon2 PHC string; `None` until a password is set.
    #[serde(default)]
    pub password_hash: Option<String>,
    /// SHA-256 (hex) of the API key; `None` when no key exists.
    #[serde(default)]
    pub api_key_hash: Option<String>,
    /// When the API key was made, unix seconds (keys made before 0.14.0
    /// have none).
    #[serde(default)]
    pub api_key_created: Option<u64>,
}

impl Default for Credentials {
    fn default() -> Credentials {
        Credentials {
            username: "admin".into(),
            password_hash: None,
            api_key_hash: None,
            api_key_created: None,
        }
    }
}

/// Hash a password for storage.
pub fn hash_password(password: &str) -> std::io::Result<String> {
    let salt = SaltString::encode_b64(&random_bytes::<16>()?)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| std::io::Error::other(e.to_string()))
}

fn verify_password(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .and_then(|h| Argon2::default().verify_password(password.as_bytes(), &h))
        .is_ok()
}

fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A random password for a run without one configured.
pub fn temporary_password() -> std::io::Result<String> {
    Ok(hex(&random_bytes::<6>()?))
}

#[derive(Debug, Default)]
struct Failures {
    count: u32,
    banned_until: Option<Instant>,
    /// The last failure, unix seconds.
    last: u64,
    user_agent: Option<String>,
}

/// Failed logins from one address, as `GET /auth/bans` shows them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedLogins {
    /// The address.
    pub ip: IpAddr,
    /// Failed logins since the last success or ban.
    pub count: u32,
    /// The last one, unix seconds.
    pub last: u64,
    /// Banned until then, unix seconds.
    pub banned_until: Option<u64>,
    /// The `User-Agent` of the last one.
    pub user_agent: Option<String>,
}

/// A login session.
#[derive(Debug, Clone)]
struct Session {
    last: Instant,
    created: u64,
    last_seen: u64,
    ip: Option<IpAddr>,
    user_agent: Option<String>,
}

/// Where a login session or the API key was last used from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Use {
    /// When, unix seconds.
    pub time: u64,
    /// The client's address.
    pub ip: Option<IpAddr>,
    /// Its `User-Agent`.
    pub user_agent: Option<String>,
}

/// A login session, as `GET /auth/sessions` shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    /// Its public id (never the cookie).
    pub id: String,
    /// When it was opened, unix seconds.
    pub created: u64,
    /// Its last use.
    pub last: Use,
}

/// The public id of a session: a digest of the cookie, which it does not
/// give away.
pub fn session_id(sid: &str) -> String {
    sha256_hex(sid)[..16].to_string()
}

/// `User-Agent` values are kept to this many characters.
const USER_AGENT_MAX: usize = 200;

/// A `User-Agent` as kept: trimmed, control characters dropped, bounded.
pub fn user_agent(ua: Option<&str>) -> Option<String> {
    let ua: String = ua?
        .chars()
        .filter(|c| !c.is_control())
        .take(USER_AGENT_MAX)
        .collect();
    let ua = ua.trim();
    (!ua.is_empty()).then(|| ua.to_string())
}

/// Authentication state.
#[derive(Debug)]
pub struct Auth {
    creds: Mutex<Credentials>,
    /// Hash of this run's temporary password, when none is configured.
    temporary: Mutex<Option<String>>,
    /// Login sessions by cookie.
    sessions: Mutex<HashMap<String, Session>>,
    failures: Mutex<HashMap<IpAddr, Failures>>,
    /// The API key's last use in this run.
    key_used: Mutex<Option<Use>>,
}

impl Auth {
    /// Start from stored credentials.
    pub fn new(creds: Credentials) -> Auth {
        Auth {
            creds: Mutex::new(creds),
            temporary: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            key_used: Mutex::new(None),
        }
    }

    /// The stored credentials.
    pub fn credentials(&self) -> Credentials {
        self.creds.lock().map(|c| c.clone()).unwrap_or_default()
    }

    /// If no password is configured, make up a temporary one for this run
    /// and return it (to be printed once).
    pub fn ensure_password(&self) -> std::io::Result<Option<String>> {
        if self.credentials().password_hash.is_some() {
            return Ok(None);
        }
        let pw = temporary_password()?;
        let hash = hash_password(&pw)?;
        if let Ok(mut t) = self.temporary.lock() {
            *t = Some(hash);
        }
        Ok(Some(pw))
    }

    /// Whether `username` / `password` are right.
    pub fn check_login(&self, username: &str, password: &str) -> bool {
        let creds = self.credentials();
        let hash = creds
            .password_hash
            .clone()
            .or_else(|| self.temporary.lock().ok().and_then(|t| t.clone()));
        let user_ok = ct_eq(creds.username.as_bytes(), username.as_bytes());
        // Verify even for a wrong user name, so timing does not tell them apart.
        let pass_ok = hash.is_some_and(|h| verify_password(&h, password));
        user_ok && pass_ok
    }

    /// Whether `ip` is banned from the API.
    pub fn is_banned(&self, ip: IpAddr) -> bool {
        let Ok(mut f) = self.failures.lock() else {
            return false;
        };
        match f.get(&ip).and_then(|x| x.banned_until) {
            Some(until) if until > Instant::now() => true,
            Some(_) => {
                f.remove(&ip);
                false
            }
            None => false,
        }
    }

    /// Count a failed login; returns whether the address is now banned.
    pub fn record_failure(
        &self,
        ip: IpAddr,
        max: u32,
        ban: Duration,
        user_agent: Option<String>,
    ) -> bool {
        let Ok(mut f) = self.failures.lock() else {
            return false;
        };
        let e = f.entry(ip).or_default();
        e.count += 1;
        e.last = now();
        e.user_agent = user_agent;
        if e.count >= max.max(1) {
            e.banned_until = Some(Instant::now() + ban);
            true
        } else {
            false
        }
    }

    /// Forget failed logins of `ip` (after a successful one, or an unban);
    /// returns whether there were any.
    pub fn clear_failures(&self, ip: IpAddr) -> bool {
        self.failures
            .lock()
            .is_ok_and(|mut f| f.remove(&ip).is_some())
    }

    /// Addresses with failed logins, banned ones included, most recent
    /// first (expired bans are forgotten).
    pub fn failed_logins(&self) -> Vec<FailedLogins> {
        let Ok(mut f) = self.failures.lock() else {
            return Vec::new();
        };
        let (instant, unix) = (Instant::now(), now());
        f.retain(|_, e| e.banned_until.is_none_or(|u| u > instant));
        let mut out: Vec<FailedLogins> = f
            .iter()
            .map(|(ip, e)| FailedLogins {
                ip: *ip,
                count: e.count,
                last: e.last,
                banned_until: e
                    .banned_until
                    .map(|u| unix + u.saturating_duration_since(instant).as_secs()),
                user_agent: e.user_agent.clone(),
            })
            .collect();
        out.sort_by(|a, b| b.last.cmp(&a.last).then(a.ip.cmp(&b.ip)));
        out
    }

    /// Open a login session for a client; returns its cookie.
    pub fn new_session(
        &self,
        ip: Option<IpAddr>,
        user_agent: Option<String>,
    ) -> std::io::Result<String> {
        let sid = hex(&random_bytes::<32>()?);
        let t = now();
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(
                sid.clone(),
                Session {
                    last: Instant::now(),
                    created: t,
                    last_seen: t,
                    ip,
                    user_agent,
                },
            );
        }
        Ok(sid)
    }

    /// Whether `sid` is a live session (idle less than `timeout`); refreshes
    /// it, and notes the address it is used from.
    pub fn touch_session(&self, sid: &str, timeout: Duration, ip: Option<IpAddr>) -> bool {
        let Ok(mut s) = self.sessions.lock() else {
            return false;
        };
        let now_i = Instant::now();
        s.retain(|_, x| now_i.duration_since(x.last) < timeout);
        match s.get_mut(sid) {
            Some(x) => {
                x.last = now_i;
                x.last_seen = now();
                if ip.is_some() {
                    x.ip = ip;
                }
                true
            }
            None => false,
        }
    }

    /// The live login sessions (idle less than `timeout`), most recently
    /// used first.
    pub fn sessions(&self, timeout: Duration) -> Vec<SessionInfo> {
        let Ok(mut s) = self.sessions.lock() else {
            return Vec::new();
        };
        let now_i = Instant::now();
        s.retain(|_, x| now_i.duration_since(x.last) < timeout);
        let mut out: Vec<SessionInfo> = s
            .iter()
            .map(|(sid, x)| SessionInfo {
                id: session_id(sid),
                created: x.created,
                last: Use {
                    time: x.last_seen,
                    ip: x.ip,
                    user_agent: x.user_agent.clone(),
                },
            })
            .collect();
        out.sort_by(|a, b| b.last.time.cmp(&a.last.time).then(a.id.cmp(&b.id)));
        out
    }

    /// Close a session.
    pub fn end_session(&self, sid: &str) {
        if let Ok(mut s) = self.sessions.lock() {
            s.remove(sid);
        }
    }

    /// Close the session with this public id; returns whether there was one.
    pub fn end_session_by_id(&self, id: &str) -> bool {
        let Ok(mut s) = self.sessions.lock() else {
            return false;
        };
        let before = s.len();
        s.retain(|sid, _| session_id(sid) != id);
        s.len() < before
    }

    /// Close every session but `keep` (a cookie); returns how many closed.
    pub fn end_other_sessions(&self, keep: Option<&str>) -> usize {
        let Ok(mut s) = self.sessions.lock() else {
            return 0;
        };
        let before = s.len();
        s.retain(|sid, _| Some(sid.as_str()) == keep);
        before - s.len()
    }

    /// Close every session (after a credentials change).
    pub fn end_all_sessions(&self) {
        if let Ok(mut s) = self.sessions.lock() {
            s.clear();
        }
    }

    /// Whether `key` is the API key.
    pub fn check_api_key(&self, key: &str) -> bool {
        let stored = self.credentials().api_key_hash;
        stored.is_some_and(|h| ct_eq(h.as_bytes(), sha256_hex(key).as_bytes()))
    }

    /// Note a use of the API key.
    pub fn api_key_used(&self, ip: Option<IpAddr>, user_agent: Option<String>) {
        if let Ok(mut u) = self.key_used.lock() {
            *u = Some(Use {
                time: now(),
                ip,
                user_agent,
            });
        }
    }

    /// The API key's last use in this run.
    pub fn api_key_use(&self) -> Option<Use> {
        self.key_used.lock().ok().and_then(|u| u.clone())
    }

    /// Make a new API key (replacing any old one). Returns the key and the
    /// credentials to persist.
    pub fn rotate_api_key(&self) -> std::io::Result<(String, Credentials)> {
        let key = format!("urtd_{}", hex(&random_bytes::<24>()?));
        let creds = self.update(|c| {
            c.api_key_hash = Some(sha256_hex(&key));
            c.api_key_created = Some(now());
        });
        if let Ok(mut u) = self.key_used.lock() {
            *u = None;
        }
        Ok((key, creds))
    }

    /// Remove the API key. Returns the credentials to persist.
    pub fn delete_api_key(&self) -> Credentials {
        if let Ok(mut u) = self.key_used.lock() {
            *u = None;
        }
        self.update(|c| {
            c.api_key_hash = None;
            c.api_key_created = None;
        })
    }

    /// Whether no password is stored yet (first-run setup is open).
    pub fn needs_setup(&self) -> bool {
        self.credentials().password_hash.is_none()
    }

    /// First-run setup: while no password is stored, put `username` and an
    /// already hashed password in force at once (one caller wins, however
    /// they interleave), keeping the API key. Returns the credentials to
    /// persist and those they replaced (for [`Auth::restore_credentials`]
    /// if persisting fails); `None` once a password is stored.
    pub fn claim_setup(
        &self,
        username: String,
        hash: String,
    ) -> Option<(Credentials, Credentials)> {
        let mut c = self.creds.lock().ok()?;
        if c.password_hash.is_some() {
            return None;
        }
        let before = c.clone();
        c.username = username;
        c.password_hash = Some(hash);
        Some((c.clone(), before))
    }

    /// Put earlier credentials back (a setup that could not be persisted).
    pub fn restore_credentials(&self, creds: Credentials) {
        self.update(|c| *c = creds);
    }

    /// The temporary password stops working (credentials are stored).
    pub fn forget_temporary(&self) {
        if let Ok(mut t) = self.temporary.lock() {
            *t = None;
        }
    }

    /// Replace user name and password. Returns the credentials to persist.
    pub fn set_credentials(
        &self,
        username: String,
        password: &str,
    ) -> std::io::Result<Credentials> {
        let hash = hash_password(password)?;
        let creds = self.update(|c| {
            c.username = username;
            c.password_hash = Some(hash);
        });
        if let Ok(mut t) = self.temporary.lock() {
            *t = None;
        }
        Ok(creds)
    }

    fn update(&self, f: impl FnOnce(&mut Credentials)) -> Credentials {
        match self.creds.lock() {
            Ok(mut c) => {
                f(&mut c);
                c.clone()
            }
            Err(_) => Credentials::default(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn login_and_keys() {
        let auth = Auth::new(Credentials::default());
        let temp = auth.ensure_password().unwrap().unwrap();
        assert!(auth.check_login("admin", &temp));
        assert!(!auth.check_login("admin", "nope"));
        assert!(!auth.check_login("root", &temp));
        auth.set_credentials("me".into(), "secret").unwrap();
        assert!(auth.check_login("me", "secret"));
        assert!(!auth.check_login("admin", &temp));
        assert!(auth.ensure_password().unwrap().is_none());

        let (key, creds) = auth.rotate_api_key().unwrap();
        assert!(!creds.api_key_hash.clone().unwrap().contains(&key));
        assert!(auth.check_api_key(&key));
        assert!(!auth.check_api_key("urtd_wrong"));
        auth.delete_api_key();
        assert!(!auth.check_api_key(&key));
    }

    #[test]
    fn setup_is_claimed_once() {
        let a = Auth::new(Credentials::default());
        let temp = a.ensure_password().unwrap().unwrap();
        assert!(a.needs_setup());
        let (creds, before) = a
            .claim_setup("me".into(), hash_password("long enough").unwrap())
            .unwrap();
        assert_eq!(creds.username, "me");
        // A second claim fails at once, before the first is persisted.
        assert!(!a.needs_setup());
        assert!(a.claim_setup("you".into(), "h".into()).is_none());
        assert!(a.check_login("me", "long enough"));
        assert!(!a.check_login("admin", &temp));
        // A setup that could not be persisted is undone: open again, and
        // the temporary password works.
        a.restore_credentials(before);
        assert!(a.needs_setup());
        assert!(a.check_login("admin", &temp));
        let (creds, _) = a
            .claim_setup("you".into(), hash_password("other one").unwrap())
            .unwrap();
        a.forget_temporary();
        assert_eq!(a.credentials(), creds);
        assert!(a.check_login("you", "other one"));
        assert!(a.claim_setup("x".into(), "h".into()).is_none());
    }

    #[test]
    fn bans_and_sessions() {
        let auth = Auth::new(Credentials::default());
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let min = Duration::from_secs(60);
        assert!(!auth.record_failure(ip, 2, min, None));
        assert_eq!(auth.failed_logins()[0].count, 1);
        assert_eq!(auth.failed_logins()[0].banned_until, None);
        assert!(auth.record_failure(ip, 2, min, user_agent(Some("curl/8.9"))));
        assert!(auth.is_banned(ip));
        let f = &auth.failed_logins()[0];
        assert!(f.banned_until.unwrap() >= now() + 59);
        assert_eq!(f.user_agent.as_deref(), Some("curl/8.9"));
        assert!(auth.clear_failures(ip));
        assert!(!auth.clear_failures(ip));
        assert!(!auth.is_banned(ip));
        assert!(auth.failed_logins().is_empty());

        let sid = auth.new_session(Some(ip), None).unwrap();
        assert!(auth.touch_session(&sid, min, None));
        auth.end_session(&sid);
        assert!(!auth.touch_session(&sid, min, None));
        let sid = auth.new_session(None, None).unwrap();
        assert!(!auth.touch_session(&sid, Duration::ZERO, None));

        // Listed by a public id, ended by it or with the others.
        let a = auth
            .new_session(Some(ip), user_agent(Some("Firefox")))
            .unwrap();
        let b = auth.new_session(None, None).unwrap();
        let c = auth.new_session(None, None).unwrap();
        let ids: Vec<String> = auth.sessions(min).into_iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), 3);
        assert!(
            !ids.iter()
                .any(|id| a.contains(id.as_str()) || id.len() != 16)
        );
        assert!(auth.end_session_by_id(&session_id(&b)));
        assert!(!auth.end_session_by_id(&session_id(&b)));
        assert_eq!(auth.end_other_sessions(Some(&a)), 1);
        assert!(!auth.touch_session(&c, min, None));
        let left = auth.sessions(min);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].last.user_agent.as_deref(), Some("Firefox"));
    }

    #[test]
    fn user_agents_are_bounded_text() {
        assert_eq!(user_agent(None), None);
        assert_eq!(user_agent(Some("  ")), None);
        assert_eq!(user_agent(Some("a\u{7}b\n")).as_deref(), Some("ab"));
        assert_eq!(user_agent(Some(&"x".repeat(500))).unwrap().len(), 200);
    }
}
