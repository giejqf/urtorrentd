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

use crate::util::{hex, random_bytes};

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
}

impl Default for Credentials {
    fn default() -> Credentials {
        Credentials {
            username: "admin".into(),
            password_hash: None,
            api_key_hash: None,
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
}

/// Authentication state.
#[derive(Debug)]
pub struct Auth {
    creds: Mutex<Credentials>,
    /// Hash of this run's temporary password, when none is configured.
    temporary: Mutex<Option<String>>,
    /// Login sessions: id -> last use.
    sessions: Mutex<HashMap<String, Instant>>,
    failures: Mutex<HashMap<IpAddr, Failures>>,
}

impl Auth {
    /// Start from stored credentials.
    pub fn new(creds: Credentials) -> Auth {
        Auth {
            creds: Mutex::new(creds),
            temporary: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
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
    pub fn record_failure(&self, ip: IpAddr, max: u32, ban: Duration) -> bool {
        let Ok(mut f) = self.failures.lock() else {
            return false;
        };
        let e = f.entry(ip).or_default();
        e.count += 1;
        if e.count >= max.max(1) {
            e.banned_until = Some(Instant::now() + ban);
            true
        } else {
            false
        }
    }

    /// Forget failed logins of `ip` after a successful one.
    pub fn clear_failures(&self, ip: IpAddr) {
        if let Ok(mut f) = self.failures.lock() {
            f.remove(&ip);
        }
    }

    /// Open a login session; returns its id.
    pub fn new_session(&self) -> std::io::Result<String> {
        let sid = hex(&random_bytes::<32>()?);
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(sid.clone(), Instant::now());
        }
        Ok(sid)
    }

    /// Whether `sid` is a live session (idle less than `timeout`); refreshes it.
    pub fn touch_session(&self, sid: &str, timeout: Duration) -> bool {
        let Ok(mut s) = self.sessions.lock() else {
            return false;
        };
        let now = Instant::now();
        s.retain(|_, last| now.duration_since(*last) < timeout);
        match s.get_mut(sid) {
            Some(last) => {
                *last = now;
                true
            }
            None => false,
        }
    }

    /// Close a session.
    pub fn end_session(&self, sid: &str) {
        if let Ok(mut s) = self.sessions.lock() {
            s.remove(sid);
        }
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

    /// Make a new API key (replacing any old one). Returns the key and the
    /// credentials to persist.
    pub fn rotate_api_key(&self) -> std::io::Result<(String, Credentials)> {
        let key = format!("urtd_{}", hex(&random_bytes::<24>()?));
        let creds = self.update(|c| c.api_key_hash = Some(sha256_hex(&key)));
        Ok((key, creds))
    }

    /// Remove the API key. Returns the credentials to persist.
    pub fn delete_api_key(&self) -> Credentials {
        self.update(|c| c.api_key_hash = None)
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
    fn bans_and_sessions() {
        let auth = Auth::new(Credentials::default());
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        assert!(!auth.record_failure(ip, 2, Duration::from_secs(60)));
        assert!(auth.record_failure(ip, 2, Duration::from_secs(60)));
        assert!(auth.is_banned(ip));
        auth.clear_failures(ip);
        assert!(!auth.is_banned(ip));

        let sid = auth.new_session().unwrap();
        assert!(auth.touch_session(&sid, Duration::from_secs(60)));
        auth.end_session(&sid);
        assert!(!auth.touch_session(&sid, Duration::from_secs(60)));
        let sid = auth.new_session().unwrap();
        assert!(!auth.touch_session(&sid, Duration::ZERO));
    }
}
