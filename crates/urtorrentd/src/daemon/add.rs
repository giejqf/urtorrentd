// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Adding torrents: resolving sources (base64 `.torrent`, magnet links, bare
//! info-hashes, `http(s)` URLs), then one engine add per torrent with the
//! daemon-side options applied around it (AGENTS.md 4.7).

use std::sync::Arc;

use axum::http::StatusCode;
use base64::Engine as _;
use urtorrent::{AddTorrent, InfoHash, MagnetLink, QueueMove, Torrent};

use super::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::model::{
    AddFailure, AddOptions, AddTorrentsRequest, AddTorrentsResponse, AddedTorrent, ContentLayout,
    MetadataFile, TimelineKind, TorrentMetadata,
};
use crate::settings::valid_tracker_url;
use crate::store::{RECORD_FORMAT, StopCondition, TorrentRecord};
use crate::util::{blocking, hex, parse_hash};

/// Whether a stored magnet needs holding once its metadata arrives.
pub(crate) fn needs_hold(r: &TorrentRecord) -> bool {
    r.magnet.is_some()
        && (r.stop_condition != StopCondition::None
            || r.content_layout != ContentLayout::Original
            || r.exclude_files)
}

/// The files `excluded_file_names` skips: a file whose name, or a folder on
/// its path, matches a pattern.
pub(crate) fn excluded_files(files: &[String], patterns: &[String]) -> Vec<usize> {
    let res: Vec<regex::Regex> = patterns
        .iter()
        .filter_map(|p| crate::util::wildcard(p).ok())
        .collect();
    if res.is_empty() {
        return Vec::new();
    }
    files
        .iter()
        .enumerate()
        .filter(|(_, f)| f.split('/').any(|seg| res.iter().any(|r| r.is_match(seg))))
        .map(|(i, _)| i)
        .collect()
}

/// Largest `.torrent` accepted from a URL.
pub(super) const MAX_TORRENT_FILE: usize = 64 * 1024 * 1024;

/// Redirects are followed (up to 10), except to a `magnet:` link, which is
/// returned to the caller as the redirect response.
pub(crate) fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() == "magnet" {
            attempt.stop()
        } else if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// Where a torrent comes from, once resolved.
pub(super) enum Source {
    Metainfo { bytes: Vec<u8> },
    Magnet { uri: String },
}

/// A resolved and parsed torrent, ready to add.
pub(super) struct Parsed {
    pub hash: InfoHash,
    pub name: String,
    private: bool,
    pub source: Source,
    source_url: Option<String>,
    /// Content file paths in file order (empty for magnets).
    files: Vec<String>,
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, ErrorCode::InvalidTorrent, message)
}

fn download_failed(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, ErrorCode::DownloadFailed, message)
}

/// The renames a content layout asks for: `(file index, new path)`.
pub fn content_renames(files: &[String], layout: ContentLayout) -> Vec<(usize, String)> {
    match layout {
        ContentLayout::Original => Vec::new(),
        ContentLayout::Subfolder => match files {
            [only] if !only.contains('/') => {
                let stem = match only.rsplit_once('.') {
                    Some((s, _)) if !s.is_empty() => s,
                    _ => only.as_str(),
                };
                vec![(0, format!("{stem}/{only}"))]
            }
            _ => Vec::new(),
        },
        ContentLayout::NoSubfolder => {
            let Some(root) = files
                .first()
                .and_then(|f| f.split_once('/'))
                .map(|(r, _)| r)
            else {
                return Vec::new();
            };
            let prefix = format!("{root}/");
            if !files.iter().all(|f| f.starts_with(&prefix)) {
                return Vec::new();
            }
            files
                .iter()
                .enumerate()
                .map(|(i, f)| (i, f.strip_prefix(&prefix).unwrap_or(f).to_string()))
                .collect()
        }
    }
}

pub(super) fn parse_metainfo(bytes: Vec<u8>, source_url: Option<String>) -> ApiResult<Parsed> {
    let t = Torrent::parse(&bytes).map_err(|e| invalid(format!("not a valid .torrent: {e}")))?;
    let files = t.info.content_files().map(|f| f.path.display()).collect();
    Ok(Parsed {
        hash: t.info.info_hash,
        name: t.info.name.clone(),
        private: t.info.private,
        files,
        source: Source::Metainfo { bytes },
        source_url,
    })
}

pub(super) fn parse_magnet(uri: String, source_url: Option<String>) -> ApiResult<Parsed> {
    let m =
        MagnetLink::parse(&uri).map_err(|e| invalid(format!("not a valid magnet link: {e}")))?;
    Ok(Parsed {
        hash: m.info_hash,
        name: m.name.clone().unwrap_or_else(|| hex(&m.info_hash)),
        private: false,
        files: Vec::new(),
        source: Source::Magnet { uri },
        source_url,
    })
}

/// Describe a `.torrent` without adding it.
pub fn parse_metadata(bytes: &[u8]) -> ApiResult<TorrentMetadata> {
    let t = Torrent::parse(bytes).map_err(|e| invalid(format!("not a valid .torrent: {e}")))?;
    Ok(TorrentMetadata {
        hash: hex(&t.info.info_hash),
        name: t.info.name.clone(),
        total_size: t.info.total_length,
        piece_size: t.info.piece_length,
        pieces: t.info.piece_count(),
        private: t.info.private,
        files: t
            .info
            .content_files()
            .map(|f| MetadataFile {
                path: f.path.display(),
                size: f.length,
            })
            .collect(),
        trackers: t.tiers(),
        web_seeds: t.url_list.clone(),
        comment: t.comment.clone(),
        created_by: t.created_by.clone(),
        creation_date: t.creation_date,
    })
}

/// Decode a base64 `.torrent`.
pub fn decode_base64(s: &str) -> ApiResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {e}")))
}

pub(crate) fn check_options(o: &AddOptions) -> ApiResult<()> {
    for (name, p) in [
        ("save_path", &o.save_path),
        ("download_path", &o.download_path),
    ] {
        if let Some(p) = p
            && !std::path::Path::new(p).is_absolute()
        {
            return Err(ApiError::bad_request(format!(
                "{name} must be an absolute path"
            )));
        }
    }
    if let Some(p) = &o.file_priorities
        && p.iter().any(|x| *x > 7)
    {
        return Err(ApiError::bad_request("file priorities range from 0 to 7"));
    }
    if let Some(c) = &o.category {
        super::organize::check_category_name(c)?;
    }
    for t in &o.tags {
        super::organize::check_tag(t)?;
    }
    Ok(())
}

impl Daemon {
    /// Add every source of a request; each succeeds or fails on its own.
    pub(crate) async fn add_torrents(
        self: &Arc<Self>,
        req: AddTorrentsRequest,
    ) -> ApiResult<AddTorrentsResponse> {
        if req.urls.is_empty() && req.torrents.is_empty() {
            return Err(ApiError::bad_request("give at least one URL or .torrent"));
        }
        check_options(&req.options)?;
        let mut out = AddTorrentsResponse::default();
        let mut parsed: Vec<(String, ApiResult<Parsed>)> = Vec::new();
        for (i, b64) in req.torrents.iter().enumerate() {
            let label = format!("torrents[{i}]");
            parsed.push((
                label,
                decode_base64(b64).and_then(|b| parse_metainfo(b, None)),
            ));
        }
        for url in &req.urls {
            let r = self.resolve_url(url, req.options.cookie.as_deref()).await;
            parsed.push((url.clone(), r));
        }
        for (label, p) in parsed {
            let (hash, result) = match p {
                Ok(p) => (Some(hex(&p.hash)), self.add_one(p, &req.options).await),
                Err(e) => (None, Err(e)),
            };
            match result {
                Ok(added) => out.added.push(added),
                Err(error) => out.failed.push(AddFailure {
                    source: label,
                    hash,
                    error: error.detail(),
                }),
            }
        }
        Ok(out)
    }

    pub(super) async fn resolve_url(&self, url: &str, cookie: Option<&str>) -> ApiResult<Parsed> {
        let url = url.trim();
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("magnet:") {
            return parse_magnet(url.to_string(), None);
        }
        if let Some(h) = parse_hash(url) {
            return parse_magnet(format!("magnet:?xt=urn:btih:{}", hex(&h)), None);
        }
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(invalid(format!(
                "{url:?} is not a magnet link, info-hash or http(s) URL"
            )));
        }
        let agent = self.settings().identity.profile().user_agent;
        let mut req = self
            .http
            .get(url)
            .header(reqwest::header::USER_AGENT, agent);
        // The jar's cookies for the URL, then the request's own.
        let cookie = match (self.cookie_header(url), cookie) {
            (Some(jar), Some(own)) => Some(format!("{jar}; {own}")),
            (jar, own) => jar.or(own.map(str::to_string)),
        };
        if let Some(c) = cookie {
            req = req.header(reqwest::header::COOKIE, c);
        }
        let mut resp = req
            .send()
            .await
            .map_err(|e| download_failed(format!("fetching {url}: {e}")))?;
        if resp.status().is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            if location.to_ascii_lowercase().starts_with("magnet:") {
                return parse_magnet(location, Some(url.to_string()));
            }
            return Err(download_failed(format!("{url}: unfollowed redirect")));
        }
        if !resp.status().is_success() {
            return Err(download_failed(format!("{url}: HTTP {}", resp.status())));
        }
        if resp
            .content_length()
            .is_some_and(|n| n > MAX_TORRENT_FILE as u64)
        {
            return Err(download_failed(format!("{url}: larger than 64 MiB")));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| download_failed(format!("reading {url}: {e}")))?
        {
            if body.len() + chunk.len() > MAX_TORRENT_FILE {
                return Err(download_failed(format!("{url}: larger than 64 MiB")));
            }
            body.extend_from_slice(&chunk);
        }
        parse_metainfo(body, Some(url.to_string()))
    }

    pub(super) async fn add_one(
        self: &Arc<Self>,
        mut p: Parsed,
        o: &AddOptions,
    ) -> ApiResult<AddedTorrent> {
        let _ops = self.ops.lock().await;
        let hash_hex = hex(&p.hash);
        // A preview of this torrent: its metadata saves a second fetch.
        if let Some(bytes) = self.take_preview(&p.hash).await
            && matches!(p.source, Source::Magnet { .. })
        {
            p = parse_metainfo(bytes, p.source_url.take())?;
        }
        let settings = self.settings();
        let existing = self.state().torrents.get(&p.hash).map(|e| e.id);
        if let Some(id) = existing {
            let merged = if settings.merge_trackers {
                self.merge_trackers(id, &p).await
            } else {
                0
            };
            let mut message = format!("torrent {hash_hex} is already added");
            if merged > 0 {
                message.push_str(&format!("; {merged} trackers or web seeds merged into it"));
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                ErrorCode::Duplicate,
                message,
            ));
        }
        let category = o.category.clone().filter(|c| !c.is_empty());
        if let Some(c) = &category {
            self.ensure_category(c).await?;
        }
        self.ensure_tags(&o.tags).await?;
        let auto = o.auto_management.unwrap_or(settings.auto_management);
        let save_path = if auto {
            self.category_save_path(category.as_deref())
        } else {
            match (&o.save_path, &category) {
                (Some(p), _) => p.clone(),
                (None, Some(c)) if settings.category_paths_in_manual_mode => {
                    self.category_save_path(Some(c))
                }
                _ => settings.save_path.clone(),
            }
        };
        let download_path = match (&o.download_path, o.use_download_path) {
            (Some(p), _) => Some(p.clone()),
            (None, Some(false)) => None,
            (None, _) if auto => self.category_download_path(category.as_deref()),
            (None, _) => settings.download_path.clone(),
        }
        .filter(|d| *d != save_path);
        let is_magnet = matches!(p.source, Source::Magnet { .. });
        let mut stopped = o.stopped.unwrap_or(settings.add_stopped);
        let mut stop_condition = o.stop_condition.unwrap_or(settings.stop_condition);
        let content_layout = o.content_layout.unwrap_or(settings.content_layout);
        if stop_condition != StopCondition::None && !is_magnet {
            // A `.torrent` has its metadata, and a torrent added paused still
            // runs its initial check and stays stopped: both conditions hold
            // by adding it stopped.
            stopped = true;
        }
        if stopped {
            stop_condition = StopCondition::None;
        }
        let renames = content_renames(&p.files, content_layout);
        let excluded = excluded_files(&p.files, &settings.excluded_file_names);
        let record = TorrentRecord {
            format: RECORD_FORMAT,
            info_hash: hash_hex.clone(),
            magnet: match &p.source {
                Source::Magnet { uri } => Some(uri.clone()),
                Source::Metainfo { .. } => None,
            },
            save_path: save_path.clone(),
            download_path: download_path.clone(),
            stopped,
            category,
            tags: o.tags.iter().cloned().collect(),
            name: o.rename.clone().filter(|n| !n.is_empty()),
            comment: None,
            auto_management: auto,
            first_last_piece_priority: o.first_last_piece_priority,
            share_limits: o.share_limits.unwrap_or_default(),
            source_url: p.source_url.clone(),
            stop_condition,
            // A magnet's layout waits for its metadata; a `.torrent`'s is
            // applied below.
            content_layout: if is_magnet {
                content_layout
            } else {
                ContentLayout::Original
            },
            exclude_files: is_magnet && !settings.excluded_file_names.is_empty(),
        };
        // Stored first: a crash right after the engine add still finds the
        // torrent on the next start. Any old row of the same info-hash (and
        // its resume data) is replaced.
        {
            let store = self.store.clone();
            let rec = record.clone();
            let bytes = match &p.source {
                Source::Metainfo { bytes } => Some(bytes.clone()),
                Source::Magnet { .. } => None,
            };
            let _g = self.persist_lock.lock().await;
            blocking(move || store.insert_torrent(&rec, bytes.as_deref())).await?;
        }
        // A torrent is held once its metadata is known when the daemon has
        // work to do before any file exists: a `.torrent` whose layout
        // renames files (held at once), a magnet with a stop condition or a
        // layout (held when the metadata arrives). `finish_hold` goes on.
        let hold = if is_magnet {
            needs_hold(&record)
        } else {
            // Held at once: layout renames and the incomplete-file suffix go
            // on before any file exists or is checked.
            !renames.is_empty() || settings.incomplete_file_suffix.is_some()
        };
        let dir = download_path.unwrap_or(save_path);
        let mut add = match p.source {
            Source::Metainfo { bytes } => AddTorrent::metainfo(bytes, dir),
            Source::Magnet { uri } => AddTorrent::magnet(uri, dir),
        }
        .paused(stopped && !hold)
        .hold_after_metadata(hold)
        .sequential(o.sequential)
        .preallocate(o.preallocate.unwrap_or(settings.preallocate))
        .auto_managed(!o.forced);
        let mut prios = o.file_priorities.clone();
        if !excluded.is_empty() {
            let n = p.files.len();
            let list = prios.get_or_insert_with(|| vec![4; n]);
            if list.len() < n {
                list.resize(n, 4);
            }
            for i in &excluded {
                if let Some(x) = list.get_mut(*i) {
                    *x = 0;
                }
            }
        }
        if let Some(prios) = prios {
            add = add.file_priorities(prios);
        }
        if let Some(l) = o.upload_limit {
            add = add.upload_limit(l);
        }
        if let Some(l) = o.download_limit {
            add = add.download_limit(l);
        }
        if let Some(n) = o.max_connections {
            add = add.max_peers(usize::try_from(n).unwrap_or(usize::MAX));
        }
        if let Some(n) = o.max_uploads.or(settings.max_uploads_per_torrent) {
            add = add.max_uploads(usize::try_from(n).unwrap_or(usize::MAX));
        }
        let id = match self.session.add_torrent(add).await {
            Ok(id) => id,
            Err(e) => {
                let store = self.store.clone();
                let h = hash_hex.clone();
                let _ = blocking(move || store.delete_torrent(&h)).await;
                return Err(e.into());
            }
        };
        self.insert(p.hash, id, record);

        // Daemon-side options around the engine add. Failures here leave the
        // torrent added and are logged.
        if o.add_to_top_of_queue
            .unwrap_or(settings.add_to_top_of_queue)
            && let Err(e) = self.session.move_in_queue(id, QueueMove::Top).await
        {
            self.logs
                .warn(format!("{}: moving to the top of the queue: {e}", p.name));
        }
        if !is_magnet && !p.private {
            self.add_auto_trackers(id, &settings.add_trackers).await;
            let fetched = self.fetched_trackers();
            self.add_auto_trackers(id, &fetched).await;
        }
        if !is_magnet && let Some(dir) = &settings.export_dir {
            self.export_torrent(p.hash, id, dir).await;
        }
        if !is_magnet {
            if hold {
                for (index, path) in &renames {
                    if let Err(e) = self.session.rename_file(id, *index, path.clone()).await {
                        self.logs
                            .warn(format!("{}: content layout rename: {e}", p.name));
                    }
                }
                if !renames.is_empty() {
                    self.invalidate_content(p.hash);
                }
                self.finish_hold(p.hash, id).await;
            } else if o.first_last_piece_priority
                && let Err(e) = self.apply_first_last(id, true).await
            {
                self.logs
                    .warn(format!("{}: first and last pieces: {e}", p.name));
            }
        }
        let name = o.rename.clone().filter(|n| !n.is_empty()).unwrap_or(p.name);
        self.logs.info(format!("added torrent {name} ({hash_hex})"));
        self.lifecycle(p.hash, TimelineKind::Added, None).await;
        Ok(AddedTorrent {
            hash: hash_hex,
            name,
        })
    }

    /// Add one torrent from a magnet link, info-hash or `.torrent` URL (RSS
    /// rules).
    pub(crate) async fn add_from_source(
        self: &Arc<Self>,
        source: &str,
        o: &AddOptions,
    ) -> ApiResult<AddedTorrent> {
        check_options(o)?;
        let p = self.resolve_url(source, o.cookie.as_deref()).await?;
        self.add_one(p, o).await
    }

    /// A held torrent (metadata known, no files yet): apply what waited for
    /// the metadata (a magnet's layout, first and last piece priority), then
    /// let it go on: checked and left stopped when a stop condition or the
    /// user said so, else started (force-started if it was added forced).
    pub(crate) async fn finish_hold(&self, hash: InfoHash, id: urtorrent::TorrentId) {
        let Some(record) = self.state().torrents.get(&hash).map(|e| e.record.clone()) else {
            return;
        };
        if record.content_layout != ContentLayout::Original {
            let files: Vec<String> = self
                .session
                .files(id)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|f| f.path)
                .collect();
            for (index, path) in content_renames(&files, record.content_layout) {
                if let Err(e) = self.session.rename_file(id, index, path).await {
                    self.logs.warn(format!(
                        "{}: content layout rename: {e}",
                        self.name_of(&hash)
                    ));
                }
            }
            self.invalidate_content(hash);
        }
        if record.exclude_files {
            self.exclude_files(hash, id).await;
        }
        // Nothing is complete while held: every file with content gets the
        // suffix; the check after the release takes it off the complete ones.
        self.apply_suffix(hash, id).await;
        if record.first_last_piece_priority
            && let Err(e) = self.apply_first_last(id, true).await
        {
            self.logs.warn(format!(
                "{}: first and last pieces: {e}",
                self.name_of(&hash)
            ));
        }
        let stop = record.stopped || record.stop_condition != StopCondition::None;
        let forced = self
            .session
            .status(id)
            .await
            .is_ok_and(|s| !s.auto_managed && !record.stopped);
        let r = if stop {
            self.session.release(id).await
        } else if forced {
            self.session.force_resume(id).await
        } else {
            self.session.resume(id).await
        };
        if let Err(e) = r {
            self.logs
                .warn(format!("{}: releasing: {e}", self.name_of(&hash)));
        }
        let _ = self
            .update_record(hash, |r| {
                r.content_layout = ContentLayout::Original;
                r.exclude_files = false;
                if stop {
                    r.stopped = true;
                    r.stop_condition = StopCondition::None;
                }
            })
            .await;
        if record.stop_condition != StopCondition::None {
            self.logs
                .info(format!("stopped {} (stop condition)", self.name_of(&hash)));
        }
    }

    /// A held magnet's metadata is here: skip its files that
    /// `excluded_file_names` names (before any file exists).
    async fn exclude_files(&self, hash: InfoHash, id: urtorrent::TorrentId) {
        let patterns = self.settings().excluded_file_names;
        let Ok(files) = self.session.files(id).await else {
            return;
        };
        let paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
        let excluded = excluded_files(&paths, &patterns);
        if excluded.is_empty() {
            return;
        }
        let prios: Vec<u8> = files
            .iter()
            .enumerate()
            .map(|(i, f)| if excluded.contains(&i) { 0 } else { f.priority })
            .collect();
        if let Err(e) = self.session.set_file_priorities(id, prios).await {
            self.logs
                .warn(format!("{}: excluded files: {e}", self.name_of(&hash)));
        }
    }

    /// `merge_trackers`: add the trackers and web seeds of a torrent added
    /// again to the one there, unless either is private (AGENTS.md rule 2)
    /// or the one there has no metadata yet (its privacy is unknown).
    /// Returns how many were added.
    async fn merge_trackers(&self, id: urtorrent::TorrentId, p: &Parsed) -> usize {
        if p.private {
            return 0;
        }
        let Ok(s) = self.session.status(id).await else {
            return 0;
        };
        if s.private || !s.has_metadata {
            return 0;
        }
        let (trackers, seeds): (Vec<String>, Vec<String>) = match &p.source {
            Source::Metainfo { bytes } => match Torrent::parse(bytes) {
                Ok(t) => (
                    t.tiers().into_iter().flatten().collect(),
                    t.url_list.clone(),
                ),
                Err(_) => return 0,
            },
            Source::Magnet { uri } => match MagnetLink::parse(uri) {
                Ok(m) => (m.trackers, m.web_seeds),
                Err(_) => return 0,
            },
        };
        let known = self.session.trackers(id).await.unwrap_or_default().len();
        self.add_auto_trackers(id, &trackers).await;
        let added = self
            .session
            .trackers(id)
            .await
            .unwrap_or_default()
            .len()
            .saturating_sub(known);
        let mut seeded = 0;
        for url in seeds {
            if !s.web_seed_urls.contains(&url) && self.session.add_web_seed(id, url).await.is_ok() {
                seeded += 1;
            }
        }
        added + seeded
    }

    /// Append the automatic tracker list, each URL in a tier of its own after
    /// the existing ones. Callers make sure the torrent is not private.
    pub(crate) async fn add_auto_trackers(&self, id: urtorrent::TorrentId, urls: &[String]) {
        if urls.is_empty() {
            return;
        }
        let existing = self.session.trackers(id).await.unwrap_or_default();
        let mut tier = existing.iter().map(|t| t.tier + 1).max().unwrap_or(0);
        for url in urls {
            if !valid_tracker_url(url) || existing.iter().any(|t| t.url == *url) {
                continue;
            }
            match self.session.add_tracker(id, url.clone(), tier).await {
                Ok(()) => tier += 1,
                Err(e) => self.logs.warn(format!("adding tracker {url}: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusions_match_names_and_folders() {
        let files: Vec<String> = [
            "Show/e1.mkv",
            "Show/Sample/s.mkv",
            "Show/info.NFO",
            "Show/e2.mkv",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let pats = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(excluded_files(&files, &pats(&["*.nfo", "sample"])), [1, 2]);
        assert_eq!(excluded_files(&files, &pats(&["e?.mkv"])), [0, 3]);
        assert!(excluded_files(&files, &[]).is_empty());
    }

    #[test]
    fn layouts() {
        let single = vec!["movie.mkv".to_string()];
        let multi = vec!["Show/e1.mkv".to_string(), "Show/sub/e2.srt".to_string()];
        assert!(content_renames(&single, ContentLayout::Original).is_empty());
        assert_eq!(
            content_renames(&single, ContentLayout::Subfolder),
            vec![(0, "movie/movie.mkv".to_string())]
        );
        assert!(content_renames(&multi, ContentLayout::Subfolder).is_empty());
        assert_eq!(
            content_renames(&multi, ContentLayout::NoSubfolder),
            vec![(0, "e1.mkv".to_string()), (1, "sub/e2.srt".to_string())]
        );
        assert!(content_renames(&single, ContentLayout::NoSubfolder).is_empty());
        let noext = vec!["README".to_string()];
        assert_eq!(
            content_renames(&noext, ContentLayout::Subfolder),
            vec![(0, "README/README".to_string())]
        );
    }
}
