// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! RSS (qBittorrent's `rss/*`): feeds in folders, their articles, and
//! download rules that add matching articles. Feeds are refreshed by the
//! tick (each at its interval, a few at once, with a delay between requests
//! to one host, conditional requests with the feed's validators); new
//! articles go through the rules when `rss_auto_download` is on, and a
//! rule's articles when the rule is saved. Adds go through the add
//! pipeline, so every add rule holds (AGENTS.md rule 2 included).

mod db;
pub(crate) mod parse;
pub(crate) mod rules;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant};

use axum::http::StatusCode;

use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::log::LogTopic;
use crate::model::{
    RssArticle, RssArticleIds, RssArticlesQuery, RssDryRunArticle, RssFeed, RssFeedDetail,
    RssFeedIds, RssFeedPatch, RssFeedRequest, RssRule, RssRuleRequest, RssVerdict,
};
use crate::util::{blocking, now};
use db::FeedRow;
use rules::Matcher;

/// Feeds refreshed at once at most.
const CONCURRENT: usize = 4;
/// Largest feed document read.
const MAX_FEED_BYTES: usize = 16 * 1024 * 1024;
/// Episodes a rule remembers (smart filter), the newest.
const MAX_MATCHED: usize = 1000;

/// What the refreshes share.
#[derive(Debug, Default)]
pub(crate) struct RssState {
    /// Feeds being refreshed.
    loading: HashSet<u32>,
    /// Feeds asked to refresh now.
    wanted: HashSet<u32>,
    /// When each host was last asked.
    hosts: HashMap<String, Instant>,
}

fn host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn check_url(url: &str) -> ApiResult<String> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url)
        .map_err(|e| ApiError::bad_request(format!("{url:?} is not a URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || url.len() > 2048
    {
        return Err(ApiError::bad_request(format!(
            "{url:?}: feeds are http or https URLs (at most 2048 bytes)"
        )));
    }
    Ok(url.to_string())
}

/// A folder path: `/`-separated names, 1 to 8 of them, each 1 to 64
/// characters without control characters or outer spaces.
fn check_folder(path: &str) -> ApiResult<String> {
    let path = path.trim_matches('/');
    let segs: Vec<&str> = path.split('/').collect();
    let ok = !path.is_empty()
        && segs.len() <= 8
        && segs.iter().all(|s| {
            !s.is_empty()
                && s.chars().count() <= 64
                && s.trim() == *s
                && !s.chars().any(char::is_control)
        });
    if ok {
        Ok(path.to_string())
    } else {
        Err(ApiError::bad_request(format!(
            "{path:?} is not a folder path (like tv/anime)"
        )))
    }
}

fn check_name(name: Option<String>) -> ApiResult<Option<String>> {
    match name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        Some(n) if n.chars().count() > 128 || n.chars().any(char::is_control) => Err(
            ApiError::bad_request("a name is at most 128 characters, without control characters"),
        ),
        n => Ok(n),
    }
}

fn check_interval(i: Option<u64>) -> ApiResult<Option<u64>> {
    match i {
        Some(s) if s < 60 => Err(ApiError::bad_request(
            "refresh_interval is at least 60 seconds",
        )),
        i => Ok(i),
    }
}

fn no_feed(id: u32) -> ApiError {
    ApiError::not_found(format!("no feed {id}"))
}

fn no_rule(name: &str) -> ApiError {
    ApiError::not_found(format!("no RSS rule {name:?}"))
}

fn view(f: FeedRow, loading: bool) -> RssFeed {
    RssFeed {
        id: f.id,
        url: f.url,
        name: f.name,
        title: f.title,
        folder: f.folder,
        refresh_interval: f.refresh_interval,
        last_refresh: f.last_refresh,
        error: f.error,
        loading,
        articles: f.articles,
        unread: f.unread,
    }
}

impl Daemon {
    fn rss(&self) -> MutexGuard<'_, RssState> {
        self.rss.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn rss_read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> std::io::Result<T> + Send + 'static,
    ) -> ApiResult<T> {
        let store = self.store.clone();
        Ok(blocking(move || store.read(f)).await?)
    }

    async fn rss_write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> std::io::Result<T> + Send + 'static,
    ) -> ApiResult<T> {
        let store = self.store.clone();
        Ok(blocking(move || store.transaction(f)).await?)
    }

    /// Every feed.
    pub(crate) async fn rss_feeds(&self) -> ApiResult<Vec<RssFeed>> {
        let rows = self.rss_read(db::feeds).await?;
        let st = self.rss();
        Ok(rows
            .into_iter()
            .map(|f| {
                let loading = st.loading.contains(&f.id);
                view(f, loading)
            })
            .collect())
    }

    async fn rss_feed_view(&self, id: u32) -> ApiResult<RssFeed> {
        let row = self
            .rss_read(move |c| db::feed(c, id))
            .await?
            .ok_or_else(|| no_feed(id))?;
        let loading = self.rss().loading.contains(&id);
        Ok(view(row, loading))
    }

    /// A feed and its articles.
    pub(crate) async fn rss_feed(&self, id: u32) -> ApiResult<RssFeedDetail> {
        let feed = self.rss_feed_view(id).await?;
        let mut articles = self
            .rss_read(move |c| db::articles(c, Some(id), false, u32::MAX))
            .await?;
        self.match_rules(&mut articles).await?;
        Ok(RssFeedDetail { feed, articles })
    }

    /// Fill in each article's `matched_rule`: the first enabled rule on its
    /// feed (by name, the order rules run in) whose filters take it, what
    /// the rule took before aside.
    async fn match_rules(&self, articles: &mut [RssArticle]) -> ApiResult<()> {
        let rules = self.rss_read(db::rules).await?;
        let rules: Vec<(RssRule, Matcher)> = rules
            .into_iter()
            .filter(|r| r.enabled)
            .map(|mut r| {
                r.ignore_days = 0;
                r.matched_episodes.clear();
                r
            })
            .filter_map(|r| Matcher::new(&r).ok().map(|m| (r, m)))
            .collect();
        let (t, repacks) = (now(), self.settings().rss_download_repacks);
        for a in articles.iter_mut() {
            a.matched_rule = rules
                .iter()
                .find(|(r, m)| {
                    r.feeds.contains(&a.feed) && m.take(r, &a.title, t, repacks).is_some()
                })
                .map(|(r, _)| r.name.clone());
        }
        Ok(())
    }

    /// Add a feed; it is refreshed at once.
    pub(crate) async fn add_rss_feed(&self, req: RssFeedRequest) -> ApiResult<RssFeed> {
        let url = check_url(&req.url)?;
        let name = check_name(req.name)?;
        let folder = req.folder.as_deref().map(check_folder).transpose()?;
        let interval = check_interval(req.refresh_interval)?;
        let _ops = self.ops.lock().await;
        let key = url.clone();
        if self
            .rss_read(move |c| db::feed_by_url(c, &key))
            .await?
            .is_some()
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                ErrorCode::Duplicate,
                "a feed with that URL exists",
            ));
        }
        let id = self
            .rss_write(move |tx| {
                db::insert_feed(tx, &url, name.as_deref(), folder.as_deref(), interval)
            })
            .await?;
        self.rss().wanted.insert(id);
        self.rss_feed_view(id).await
    }

    /// Change a feed.
    pub(crate) async fn patch_rss_feed(&self, id: u32, p: RssFeedPatch) -> ApiResult<RssFeed> {
        let _ops = self.ops.lock().await;
        let old = self
            .rss_read(move |c| db::feed(c, id))
            .await?
            .ok_or_else(|| no_feed(id))?;
        let url = match p.url {
            Some(u) => check_url(&u)?,
            None => old.url.clone(),
        };
        if url != old.url {
            let key = url.clone();
            if self
                .rss_read(move |c| db::feed_by_url(c, &key))
                .await?
                .is_some()
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ErrorCode::Duplicate,
                    "a feed with that URL exists",
                ));
            }
        }
        let name = match p.name {
            Some(n) => check_name(n)?,
            None => old.name,
        };
        let folder = match p.folder {
            Some(f) => f.as_deref().map(check_folder).transpose()?,
            None => old.folder,
        };
        let interval = match p.refresh_interval {
            Some(i) => check_interval(i)?,
            None => old.refresh_interval,
        };
        let changed_url = url != old.url;
        self.rss_write(move |tx| {
            db::update_feed(tx, id, &url, name.as_deref(), folder.as_deref(), interval)
        })
        .await?;
        if changed_url {
            self.rss().wanted.insert(id);
        }
        self.rss_feed_view(id).await
    }

    /// Remove a feed and its articles.
    pub(crate) async fn delete_rss_feed(&self, id: u32) -> ApiResult<()> {
        let _ops = self.ops.lock().await;
        if self.rss_write(move |tx| db::delete_feed(tx, id)).await? {
            Ok(())
        } else {
            Err(no_feed(id))
        }
    }

    /// Refresh a feed now (qBittorrent's `refreshItem`), whether or not
    /// `rss_enabled` is on.
    pub(crate) async fn refresh_rss_feed(&self, id: u32) -> ApiResult<()> {
        self.rss_feed_view(id).await?;
        self.rss().wanted.insert(id);
        Ok(())
    }

    /// The feeds of a bulk request, all known (404 for the first that is
    /// not).
    async fn rss_feed_ids(&self, ids: RssFeedIds) -> ApiResult<Vec<u32>> {
        let known: Vec<u32> = self
            .rss_read(db::feeds)
            .await?
            .iter()
            .map(|f| f.id)
            .collect();
        match ids {
            RssFeedIds::All(_) => Ok(known),
            RssFeedIds::List(l) => match l.iter().find(|id| !known.contains(id)) {
                Some(id) => Err(no_feed(*id)),
                None => Ok(l),
            },
        }
    }

    /// Refresh several feeds now.
    pub(crate) async fn refresh_rss_feeds(&self, ids: RssFeedIds) -> ApiResult<()> {
        let ids = self.rss_feed_ids(ids).await?;
        self.rss().wanted.extend(ids);
        Ok(())
    }

    /// Mark every article of several feeds read.
    pub(crate) async fn mark_rss_feeds_read(&self, ids: RssFeedIds) -> ApiResult<()> {
        let ids = self.rss_feed_ids(ids).await?;
        self.rss_write(move |tx| {
            for id in ids {
                db::mark_read(tx, id, None, true)?;
            }
            Ok(())
        })
        .await
    }

    /// Articles across feeds, newest first.
    pub(crate) async fn rss_articles(&self, q: RssArticlesQuery) -> ApiResult<Vec<RssArticle>> {
        let limit = q.limit.unwrap_or(500);
        if !(1..=5000).contains(&limit) {
            return Err(ApiError::bad_request("`limit` must be 1 to 5000"));
        }
        let unread = q.unread.unwrap_or(false);
        let mut articles = self
            .rss_read(move |c| db::articles(c, q.feed, unread, limit))
            .await?;
        self.match_rules(&mut articles).await?;
        Ok(articles)
    }

    /// Mark articles of a feed read, or unread.
    pub(crate) async fn mark_rss_read(
        &self,
        id: u32,
        ids: RssArticleIds,
        read: bool,
    ) -> ApiResult<()> {
        self.rss_feed_view(id).await?;
        self.rss_write(move |tx| match ids {
            RssArticleIds::All(_) => db::mark_read(tx, id, None, read),
            RssArticleIds::List(l) => db::mark_read(tx, id, Some(&l), read),
        })
        .await?;
        Ok(())
    }

    /// Every folder.
    pub(crate) async fn rss_folders(&self) -> ApiResult<Vec<String>> {
        self.rss_read(db::folders).await
    }

    /// Add a folder.
    pub(crate) async fn add_rss_folder(&self, path: &str) -> ApiResult<()> {
        let path = check_folder(path)?;
        self.rss_write(move |tx| db::add_folder(tx, &path)).await
    }

    /// Remove a folder with its subfolders and feeds.
    pub(crate) async fn remove_rss_folder(&self, path: &str) -> ApiResult<()> {
        let path = check_folder(path)?;
        let _ops = self.ops.lock().await;
        let shown = path.clone();
        match self
            .rss_write(move |tx| db::remove_folder(tx, &path))
            .await?
        {
            Some(_) => Ok(()),
            None => Err(ApiError::not_found(format!("no folder {shown:?}"))),
        }
    }

    /// Move a folder with what is in it.
    pub(crate) async fn move_rss_folder(&self, from: &str, to: &str) -> ApiResult<()> {
        let (from, to) = (check_folder(from)?, check_folder(to)?);
        if to == from || to.starts_with(&format!("{from}/")) {
            return Err(ApiError::bad_request("a folder cannot move into itself"));
        }
        let _ops = self.ops.lock().await;
        let shown = from.clone();
        if self
            .rss_write(move |tx| db::move_folder(tx, &from, &to))
            .await?
        {
            Ok(())
        } else {
            Err(ApiError::not_found(format!("no folder {shown:?}")))
        }
    }

    /// Every rule.
    pub(crate) async fn rss_rules(&self) -> ApiResult<Vec<RssRule>> {
        self.rss_read(db::rules).await
    }

    async fn rss_rule(&self, name: &str) -> ApiResult<RssRule> {
        self.rss_rules()
            .await?
            .into_iter()
            .find(|r| r.name == name)
            .ok_or_else(|| no_rule(name))
    }

    /// Create or replace a rule (keeping its history unless asked not to),
    /// then run it over its feeds' articles when auto-download is on.
    pub(crate) async fn put_rss_rule(
        self: &Arc<Self>,
        name: &str,
        req: RssRuleRequest,
    ) -> ApiResult<RssRule> {
        let name = check_name(Some(name.to_string()))?
            .ok_or_else(|| ApiError::bad_request("a rule needs a name"))?;
        crate::daemon::check_add_options(&req.add_options)?;
        let lock = self.rss_rules_lock.lock().await;
        let old = self.rss_rule(&name).await.ok();
        let keep = old.filter(|_| !req.reset_history);
        let rule = RssRule {
            name,
            enabled: req.enabled.unwrap_or(true),
            must_contain: req.must_contain,
            must_not_contain: req.must_not_contain,
            use_regex: req.use_regex,
            episode_filter: req.episode_filter,
            smart_filter: req.smart_filter,
            feeds: req.feeds,
            ignore_days: req.ignore_days,
            add_options: req.add_options,
            last_match: keep.as_ref().and_then(|o| o.last_match),
            matched_episodes: keep.map(|o| o.matched_episodes).unwrap_or_default(),
        };
        Matcher::new(&rule).map_err(ApiError::bad_request)?;
        let known: HashSet<u32> = self
            .rss_read(db::feeds)
            .await?
            .iter()
            .map(|f| f.id)
            .collect();
        if let Some(f) = rule.feeds.iter().find(|f| !known.contains(f)) {
            return Err(ApiError::bad_request(format!("no feed {f}")));
        }
        let stored = rule.clone();
        self.rss_read(move |c| db::put_rule(c, &stored)).await?;
        drop(lock);
        if self.settings().rss_auto_download && rule.enabled {
            let d = self.clone();
            let feeds = rule.feeds.clone();
            tokio::spawn(async move {
                for f in feeds {
                    d.run_rules(f, None).await;
                }
            });
        }
        Ok(rule)
    }

    /// Rename a rule.
    pub(crate) async fn rename_rss_rule(&self, name: &str, to: &str) -> ApiResult<RssRule> {
        let to = check_name(Some(to.to_string()))?
            .ok_or_else(|| ApiError::bad_request("a rule needs a name"))?;
        let _lock = self.rss_rules_lock.lock().await;
        let mut rule = self.rss_rule(name).await?;
        if to != name && self.rss_rule(&to).await.is_ok() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                ErrorCode::Duplicate,
                format!("a rule named {to:?} exists"),
            ));
        }
        let old = rule.name.clone();
        rule.name = to;
        let stored = rule.clone();
        self.rss_write(move |tx| {
            db::delete_rule(tx, &old)?;
            db::put_rule(tx, &stored)
        })
        .await?;
        Ok(rule)
    }

    /// Remove a rule.
    pub(crate) async fn delete_rss_rule(&self, name: &str) -> ApiResult<()> {
        let _lock = self.rss_rules_lock.lock().await;
        let key = name.to_string();
        if self.rss_read(move |c| db::delete_rule(c, &key)).await? {
            Ok(())
        } else {
            Err(no_rule(name))
        }
    }

    /// The articles of a rule's feeds its filters take (qBittorrent's
    /// `matchingArticles`): a dry run, without its history (`last_match`,
    /// the smart filter's episodes).
    pub(crate) async fn rss_rule_matches(&self, name: &str) -> ApiResult<Vec<RssArticle>> {
        let mut rule = self.rss_rule(name).await?;
        rule.enabled = true;
        rule.ignore_days = 0;
        rule.matched_episodes.clear();
        let m = Matcher::new(&rule).map_err(ApiError::bad_request)?;
        let feeds = rule.feeds.clone();
        let articles = self
            .rss_read(move |c| {
                let mut out = Vec::new();
                for f in feeds {
                    out.extend(db::articles(c, Some(f), false, u32::MAX)?);
                }
                Ok(out)
            })
            .await?;
        let repacks = self.settings().rss_download_repacks;
        let mut taken: Vec<RssArticle> = articles
            .into_iter()
            .filter(|a| m.take(&rule, &a.title, now(), repacks).is_some())
            .collect();
        self.match_rules(&mut taken).await?;
        Ok(taken)
    }

    /// What a rule as given would do with each article of its feeds,
    /// newest first: a dry run of a rule being edited (nothing is saved or
    /// added; no history applies, as in [`Daemon::rss_rule_matches`]).
    pub(crate) async fn rss_rule_dry_run(
        &self,
        req: RssRuleRequest,
    ) -> ApiResult<Vec<RssDryRunArticle>> {
        crate::daemon::check_add_options(&req.add_options)?;
        let rule = RssRule {
            name: String::new(),
            enabled: true,
            must_contain: req.must_contain,
            must_not_contain: req.must_not_contain,
            use_regex: req.use_regex,
            episode_filter: req.episode_filter,
            smart_filter: req.smart_filter,
            feeds: req.feeds,
            ignore_days: 0,
            add_options: req.add_options,
            last_match: None,
            matched_episodes: Vec::new(),
        };
        let m = Matcher::new(&rule).map_err(ApiError::bad_request)?;
        let feeds = rule.feeds.clone();
        let mut articles = self
            .rss_read(move |c| {
                let mut out = Vec::new();
                for f in feeds {
                    out.extend(db::articles(c, Some(f), false, u32::MAX)?);
                }
                Ok(out)
            })
            .await?;
        articles.sort_by_key(|a| std::cmp::Reverse(a.date));
        self.match_rules(&mut articles).await?;
        let repacks = self.settings().rss_download_repacks;
        let t = now();
        Ok(articles
            .into_iter()
            .map(|a| {
                let judged = m.judge(&rule, &a.title, t, repacks);
                RssDryRunArticle {
                    verdict: match (&judged, a.downloaded) {
                        (Ok(_), false) => RssVerdict::Take,
                        (Ok(_), true) => RssVerdict::Taken,
                        (Err(_), _) => RssVerdict::Filtered,
                    },
                    reason: judged.err(),
                    article: a,
                }
            })
            .collect())
    }

    /// Start the refreshes that are due (the tick).
    pub(crate) async fn rss_tick(self: &Arc<Self>) {
        let s = self.settings();
        if !s.rss_enabled && self.rss().wanted.is_empty() {
            return;
        }
        let Ok(feeds) = self.rss_read(db::feeds).await else {
            return;
        };
        let t = now();
        let delay = Duration::from_secs(s.rss_fetch_delay);
        let mut start = Vec::new();
        {
            let mut st = self.rss();
            st.wanted.retain(|id| feeds.iter().any(|f| f.id == *id));
            for f in feeds {
                if st.loading.len() >= CONCURRENT {
                    break;
                }
                let every = f.refresh_interval.unwrap_or(s.rss_refresh_interval);
                let due = st.wanted.contains(&f.id)
                    || (s.rss_enabled && f.last_refresh.is_none_or(|l| t >= l + every));
                let h = host(&f.url);
                let host_free = st.hosts.get(&h).is_none_or(|at| at.elapsed() >= delay);
                if due && !st.loading.contains(&f.id) && host_free {
                    st.loading.insert(f.id);
                    st.wanted.remove(&f.id);
                    st.hosts.insert(h, Instant::now());
                    start.push(f);
                }
            }
        }
        for f in start {
            let d = self.clone();
            tokio::spawn(async move {
                let id = f.id;
                d.refresh_feed(f).await;
                d.rss().loading.remove(&id);
            });
        }
    }

    /// Fetch a feed, keep its articles, run the rules on the new ones.
    async fn refresh_feed(self: &Arc<Self>, f: FeedRow) {
        let label = f
            .name
            .clone()
            .or(f.title.clone())
            .unwrap_or_else(|| host(&f.url));
        let t = now();
        let fetched = self.fetch_feed(&f).await;
        let (id, keep) = (f.id, self.settings().rss_max_articles);
        let result = match fetched {
            Ok(None) => {
                // Not modified.
                self.rss_write(move |tx| {
                    db::save_refresh(
                        tx,
                        id,
                        t,
                        None,
                        f.etag.as_deref(),
                        f.last_modified.as_deref(),
                        &[],
                        keep,
                    )
                })
                .await
                .map(|_| Vec::new())
            }
            Ok(Some((doc, etag, modified))) => {
                self.rss_write(move |tx| {
                    db::save_refresh(
                        tx,
                        id,
                        t,
                        doc.title.as_deref(),
                        etag.as_deref(),
                        modified.as_deref(),
                        &doc.items,
                        keep,
                    )
                })
                .await
            }
            Err(e) => {
                self.logs
                    .warn(LogTopic::Rss, format!("RSS feed {label}: {e}"));
                let _ = self.rss_read(move |c| db::save_error(c, id, t, &e)).await;
                return;
            }
        };
        match result {
            Ok(new) if !new.is_empty() && self.settings().rss_auto_download => {
                self.run_rules(id, Some(new)).await;
            }
            Ok(_) => {}
            Err(e) => self
                .logs
                .warn(LogTopic::Rss, format!("RSS feed {label}: {e}")),
        }
    }

    /// The document, with its validators; `None` = not modified.
    #[allow(clippy::type_complexity)]
    async fn fetch_feed(
        &self,
        f: &FeedRow,
    ) -> Result<Option<(parse::ParsedFeed, Option<String>, Option<String>)>, String> {
        let agent = self.settings().identity.profile().user_agent;
        let mut req = self
            .http
            .get(&f.url)
            .header(reqwest::header::USER_AGENT, agent);
        if let Some(c) = self.cookie_header(&f.url) {
            req = req.header(reqwest::header::COOKIE, c);
        }
        if let Some(e) = &f.etag {
            req = req.header(reqwest::header::IF_NONE_MATCH, e);
        }
        if let Some(m) = &f.last_modified {
            req = req.header(reqwest::header::IF_MODIFIED_SINCE, m);
        }
        // Feed URLs often carry a passkey: errors are shown without it.
        let mut resp = req.send().await.map_err(|e| e.without_url().to_string())?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let header = |name| {
            resp.headers()
                .get(name)
                .and_then(|v: &reqwest::header::HeaderValue| v.to_str().ok())
                .map(str::to_string)
        };
        let etag = header(reqwest::header::ETAG);
        let modified = header(reqwest::header::LAST_MODIFIED);
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if body.len() + chunk.len() > MAX_FEED_BYTES {
                return Err("larger than 16 MiB".into());
            }
            body.extend_from_slice(&chunk);
        }
        let doc = blocking(move || parse::parse(&body).map_err(std::io::Error::other))
            .await
            .map_err(|e| e.to_string())?;
        Ok(Some((doc, etag, modified)))
    }

    /// Run the enabled rules of a feed over its articles (`only`: these
    /// ids; `None`: all), oldest first; what a rule takes is added.
    pub(crate) async fn run_rules(self: &Arc<Self>, feed: u32, only: Option<Vec<String>>) {
        let _lock = self.rss_rules_lock.lock().await;
        let Ok((rules, mut articles)) = self
            .rss_read(move |c| Ok((db::rules(c)?, db::articles(c, Some(feed), false, u32::MAX)?)))
            .await
        else {
            return;
        };
        articles.reverse();
        articles.retain(|a| !a.downloaded && only.as_ref().is_none_or(|o| o.contains(&a.id)));
        let mut rules: Vec<(RssRule, Matcher)> = rules
            .into_iter()
            .filter(|r| r.enabled && r.feeds.contains(&feed))
            .filter_map(|r| Matcher::new(&r).ok().map(|m| (r, m)))
            .collect();
        let repacks = self.settings().rss_download_repacks;
        for a in articles {
            for (rule, m) in rules.iter_mut() {
                let Some(key) = m.take(rule, &a.title, now(), repacks) else {
                    continue;
                };
                let Some(source) = a.torrent_url.clone().or(a.link.clone()) else {
                    continue;
                };
                let added = match self.add_from_source(&source, &rule.add_options).await {
                    Ok(t) => {
                        self.logs.info_on(
                            LogTopic::Rss,
                            t.hash.as_str(),
                            format!("RSS rule {:?} added {}", rule.name, t.name),
                        );
                        true
                    }
                    Err(e) if e.code == ErrorCode::Duplicate => true,
                    Err(e) => {
                        self.logs.warn(
                            LogTopic::Rss,
                            format!("RSS rule {:?}: {}: {}", rule.name, a.title, e.message),
                        );
                        false
                    }
                };
                if added {
                    rule.last_match = Some(now());
                    if let Some(k) = key {
                        rule.matched_episodes.push(k);
                        let n = rule.matched_episodes.len();
                        if n > MAX_MATCHED {
                            rule.matched_episodes.drain(..n - MAX_MATCHED);
                        }
                    }
                    let (stored, art) = (rule.clone(), a.id.clone());
                    let _ = self
                        .rss_read(move |c| {
                            db::put_rule(c, &stored)?;
                            db::mark_downloaded(c, feed, &art)
                        })
                        .await;
                }
                break;
            }
        }
    }
}
