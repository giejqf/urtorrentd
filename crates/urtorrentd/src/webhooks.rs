// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Webhooks: qBittorrent's "run external program" (on add, on completion)
//! as HTTP calls, not programs (maintainer decision, 2026-09-24): the daemon
//! never starts a process. Each event a webhook subscribes to is a `POST`
//! of a [`WebhookPayload`] (typed in the schema), optionally signed with
//! HMAC-SHA256. Redirects are not followed. Deliveries run in the
//! background and are retried when there is no answer, 429 or 5xx; the last
//! ones are kept with what they sent, so one can be sent again, but not
//! across restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::error::{ApiError, ApiResult};
use crate::model::{
    Webhook, WebhookDelivery, WebhookEvent, WebhookPatch, WebhookPayload, WebhookRequest,
};
use crate::util::{hex, now, random_bytes};

/// Webhooks at most.
pub const MAX_WEBHOOKS: usize = 32;
/// Deliveries remembered per webhook, each with its payload.
const KEEP_DELIVERIES: usize = 20;
/// Waits before the retries.
const RETRIES: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(10),
    Duration::from_secs(60),
];
/// One request's time limit.
const TIMEOUT: Duration = Duration::from_secs(10);

/// A webhook as stored (the `state` table, key `webhooks`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredWebhook {
    /// Id.
    pub id: u32,
    /// Label.
    pub name: Option<String>,
    /// Target.
    pub url: String,
    /// Subscribed events; empty = all.
    pub events: Vec<WebhookEvent>,
    /// Signing secret.
    pub secret: Option<String>,
    /// On.
    pub enabled: bool,
}

impl StoredWebhook {
    fn wants(&self, event: WebhookEvent) -> bool {
        self.enabled && (self.events.is_empty() || self.events.contains(&event))
    }
}

fn check_url(url: &str) -> ApiResult<String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| ApiError::bad_request(format!("{url:?} is not a URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(ApiError::bad_request(format!(
            "{url:?}: webhooks are http or https URLs"
        )));
    }
    if url.len() > 2048 {
        return Err(ApiError::bad_request("the URL is longer than 2048 bytes"));
    }
    Ok(url.to_string())
}

fn check_name(name: Option<String>) -> ApiResult<Option<String>> {
    match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) if n.chars().count() > 64 => Err(ApiError::bad_request(
            "the name is longer than 64 characters",
        )),
        n => Ok(n),
    }
}

fn check_secret(secret: Option<String>) -> ApiResult<Option<String>> {
    match secret {
        Some(s) if s.is_empty() || s.len() > 256 => {
            Err(ApiError::bad_request("the secret must be 1 to 256 bytes"))
        }
        s => Ok(s),
    }
}

fn dedup(events: Vec<WebhookEvent>) -> Vec<WebhookEvent> {
    let mut out = Vec::new();
    for e in events {
        if !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

/// `sha256=<hex>`: the HMAC-SHA256 of `<timestamp>.<body>`.
pub fn signature(secret: &str, timestamp: u64, body: &[u8]) -> String {
    #[allow(clippy::expect_used)] // HMAC takes a key of any length.
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    format!("sha256={}", hex(&mac.finalize().into_bytes()))
}

/// The webhooks and their recent deliveries.
#[derive(Debug)]
pub struct Webhooks {
    hooks: RwLock<Vec<StoredWebhook>>,
    deliveries: Mutex<HashMap<u32, VecDeque<(WebhookDelivery, WebhookPayload)>>>,
    client: reqwest::Client,
}

impl Webhooks {
    /// From the stored list.
    pub fn new(hooks: Vec<StoredWebhook>) -> Result<Webhooks, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent(concat!("urtorrentd/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Webhooks {
            hooks: RwLock::new(hooks),
            deliveries: Mutex::new(HashMap::new()),
            client,
        })
    }

    fn hooks(&self) -> Vec<StoredWebhook> {
        self.hooks.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// What to store.
    pub fn stored(&self) -> Vec<StoredWebhook> {
        self.hooks()
    }

    fn view(&self, h: &StoredWebhook) -> Webhook {
        let deliveries = self
            .deliveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&h.id)
            .map(|d| d.iter().map(|(d, _)| d.clone()).collect())
            .unwrap_or_default();
        Webhook {
            id: h.id,
            name: h.name.clone(),
            url: h.url.clone(),
            events: h.events.clone(),
            enabled: h.enabled,
            has_secret: h.secret.is_some(),
            deliveries,
        }
    }

    /// Whether an enabled webhook wants `event`.
    pub fn wanted(&self, event: WebhookEvent) -> bool {
        self.hooks
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|h| h.wants(event))
    }

    /// Every webhook.
    pub fn list(&self) -> Vec<Webhook> {
        self.hooks().iter().map(|h| self.view(h)).collect()
    }

    /// One webhook.
    pub fn get(&self, id: u32) -> ApiResult<Webhook> {
        self.hooks()
            .iter()
            .find(|h| h.id == id)
            .map(|h| self.view(h))
            .ok_or_else(|| ApiError::not_found(format!("no webhook {id}")))
    }

    /// Add one.
    pub fn create(&self, req: WebhookRequest) -> ApiResult<Webhook> {
        let hook = {
            let mut hooks = self.hooks.write().unwrap_or_else(|e| e.into_inner());
            if hooks.len() >= MAX_WEBHOOKS {
                return Err(ApiError::conflict(format!(
                    "{MAX_WEBHOOKS} webhooks at most"
                )));
            }
            let hook = StoredWebhook {
                id: hooks.iter().map(|h| h.id).max().unwrap_or(0) + 1,
                name: check_name(req.name)?,
                url: check_url(&req.url)?,
                events: dedup(req.events),
                secret: check_secret(req.secret)?,
                enabled: req.enabled.unwrap_or(true),
            };
            hooks.push(hook.clone());
            hook
        };
        Ok(self.view(&hook))
    }

    /// Change one.
    pub fn update(&self, id: u32, p: WebhookPatch) -> ApiResult<Webhook> {
        let hook = {
            let mut hooks = self.hooks.write().unwrap_or_else(|e| e.into_inner());
            let h = hooks
                .iter_mut()
                .find(|h| h.id == id)
                .ok_or_else(|| ApiError::not_found(format!("no webhook {id}")))?;
            let mut next = h.clone();
            if let Some(url) = p.url {
                next.url = check_url(&url)?;
            }
            if let Some(name) = p.name {
                next.name = check_name(name)?;
            }
            if let Some(events) = p.events {
                next.events = dedup(events);
            }
            if let Some(secret) = p.secret {
                next.secret = check_secret(secret)?;
            }
            if let Some(on) = p.enabled {
                next.enabled = on;
            }
            *h = next.clone();
            next
        };
        Ok(self.view(&hook))
    }

    /// Remove one.
    pub fn delete(&self, id: u32) -> ApiResult<()> {
        let mut hooks = self.hooks.write().unwrap_or_else(|e| e.into_inner());
        let before = hooks.len();
        hooks.retain(|h| h.id != id);
        if hooks.len() == before {
            return Err(ApiError::not_found(format!("no webhook {id}")));
        }
        self.deliveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        Ok(())
    }

    /// A payload for an event, with a fresh delivery id.
    pub fn payload(
        event: WebhookEvent,
        hash: Option<String>,
        torrent: Option<crate::model::TorrentSummary>,
        detail: Option<String>,
    ) -> WebhookPayload {
        WebhookPayload {
            event,
            time: now(),
            delivery: random_bytes::<12>().map(|b| hex(&b)).unwrap_or_default(),
            hash,
            torrent,
            detail,
        }
    }

    /// Send an event to every webhook that wants it, in the background.
    pub fn fire(self: &Arc<Self>, payload: WebhookPayload) {
        for hook in self.hooks().into_iter().filter(|h| h.wants(payload.event)) {
            let this = self.clone();
            let payload = payload.clone();
            tokio::spawn(async move {
                let d = this.deliver(&hook, &payload, true).await;
                this.remember(hook.id, d, payload);
            });
        }
    }

    /// Send a `test` event to one webhook now, without retries.
    pub async fn test(&self, id: u32) -> ApiResult<WebhookDelivery> {
        let hook = self
            .hooks()
            .into_iter()
            .find(|h| h.id == id)
            .ok_or_else(|| ApiError::not_found(format!("no webhook {id}")))?;
        let payload = Self::payload(WebhookEvent::Test, None, None, None);
        let d = self.deliver(&hook, &payload, false).await;
        self.remember(id, d.clone(), payload);
        Ok(d)
    }

    /// What one of a webhook's last deliveries sent.
    pub fn sent(&self, id: u32, delivery: &str) -> ApiResult<WebhookPayload> {
        self.get(id)?;
        self.deliveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .and_then(|list| list.iter().find(|(d, _)| d.id == delivery))
            .map(|(_, p)| p.clone())
            .ok_or_else(|| ApiError::not_found(format!("no delivery {delivery:?} of webhook {id}")))
    }

    /// Send one of a webhook's last deliveries again, now and once: the
    /// same payload and delivery id (receivers can tell it is the same
    /// event), a fresh timestamp and signature.
    pub async fn redeliver(&self, id: u32, delivery: &str) -> ApiResult<WebhookDelivery> {
        let payload = self.sent(id, delivery)?;
        let hook = self
            .hooks()
            .into_iter()
            .find(|h| h.id == id)
            .ok_or_else(|| ApiError::not_found(format!("no webhook {id}")))?;
        let mut d = self.deliver(&hook, &payload, false).await;
        d.time = now();
        self.remember(id, d.clone(), payload);
        Ok(d)
    }

    fn remember(&self, id: u32, d: WebhookDelivery, payload: WebhookPayload) {
        if !self.hooks().iter().any(|h| h.id == id) {
            return;
        }
        let mut all = self.deliveries.lock().unwrap_or_else(|e| e.into_inner());
        let list = all.entry(id).or_default();
        list.push_front((d, payload));
        list.truncate(KEEP_DELIVERIES);
    }

    async fn deliver(
        &self,
        hook: &StoredWebhook,
        p: &WebhookPayload,
        retry: bool,
    ) -> WebhookDelivery {
        let body = serde_json::to_vec(p).unwrap_or_default();
        let event = serde_json::to_value(p.event)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let mut out = WebhookDelivery {
            id: p.delivery.clone(),
            time: p.time,
            event: p.event,
            hash: p.hash.clone(),
            status: None,
            error: None,
            attempts: 0,
        };
        let waits = if retry { &RETRIES[..] } else { &[] };
        for attempt in 0..=waits.len() {
            if attempt > 0 {
                tokio::time::sleep(waits[attempt - 1]).await;
            }
            out.attempts += 1;
            let ts = now();
            let mut req = self
                .client
                .post(&hook.url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header("X-Urtorrentd-Event", &event)
                .header("X-Urtorrentd-Delivery", &p.delivery)
                .header("X-Urtorrentd-Timestamp", ts.to_string())
                .body(body.clone());
            if let Some(secret) = &hook.secret {
                req = req.header("X-Urtorrentd-Signature", signature(secret, ts, &body));
            }
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    out.status = Some(status.as_u16());
                    if status.is_success() {
                        out.error = None;
                        return out;
                    }
                    out.error = Some(format!("HTTP {status}"));
                    if !(status.is_server_error() || status.as_u16() == 429) {
                        return out;
                    }
                }
                Err(e) => {
                    out.status = None;
                    // Without the URL: webhook URLs often carry a token.
                    out.error = Some(e.without_url().to_string());
                }
            }
        }
        out
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_hmac_sha256() {
        // The MAC is RFC 4231's (test case 2).
        let s = signature("Jefe", 0, b"");
        assert_eq!(s.len(), "sha256=".len() + 64);
        let mut mac = Hmac::<Sha256>::new_from_slice(b"Jefe").unwrap();
        mac.update(b"what do ya want for nothing?");
        assert_eq!(
            hex(&mac.finalize().into_bytes()),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        assert_ne!(
            signature("a", 1, b"x"),
            signature("a", 2, b"x"),
            "the timestamp is signed"
        );
    }

    #[test]
    fn urls_names_and_secrets_are_checked() {
        assert!(check_url("https://example.org/hook").is_ok());
        assert!(check_url("ftp://example.org/").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("not a url").is_err());
        assert_eq!(check_name(Some("  ".into())).ok(), Some(None));
        assert!(check_name(Some("x".repeat(65))).is_err());
        assert!(check_secret(Some(String::new())).is_err());
        assert_eq!(
            dedup(vec![
                WebhookEvent::Added,
                WebhookEvent::Added,
                WebhookEvent::Removed
            ]),
            vec![WebhookEvent::Added, WebhookEvent::Removed]
        );
    }
}
