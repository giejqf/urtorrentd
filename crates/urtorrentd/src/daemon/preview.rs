// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Metadata previews (qBittorrent's `fetchMetadata` / `saveMetadata`): a
//! torrent's metadata without adding it. A URL is downloaded and parsed; a
//! magnet link is added to the engine with `hold_after_metadata`, outside the
//! queue and outside the registry (so it is in no list, statistic or file),
//! and once the metadata arrives the daemon keeps the `.torrent` bytes and
//! removes the engine torrent. Adding the same info-hash uses the bytes.
//! Previews live in memory only; one that is not read for
//! [`PREVIEW_TTL`] goes away. The trackers of the `add_trackers` setting are
//! not added to a preview (AGENTS.md rule 2 holds either way: a magnet's
//! privacy is unknown until its metadata arrives).

use std::time::{Duration, Instant};

use axum::http::StatusCode;
use urtorrent::{AddTorrent, InfoHash, TorrentId};

use super::Daemon;
use super::add::{Parsed, Source, parse_metadata};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::model::{PreviewInfo, PreviewRequest, PreviewState};
use crate::util::{hex, now, parse_hash};

/// Previews at once.
pub(crate) const MAX_PREVIEWS: usize = 32;
/// A preview not read for this long is dropped.
pub(crate) const PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);

/// A preview.
#[derive(Debug)]
pub(crate) struct Preview {
    /// The engine torrent while fetching.
    id: Option<TorrentId>,
    name: String,
    created: u64,
    touched: Instant,
    /// The `.torrent`, once here.
    metainfo: Option<Vec<u8>>,
    error: Option<String>,
}

fn no_preview(hash: &str) -> ApiError {
    ApiError::not_found(format!("no preview of {hash}"))
}

impl Daemon {
    fn preview_hash(&self, id: TorrentId) -> Option<InfoHash> {
        self.state()
            .previews
            .iter()
            .find(|(_, p)| p.id == Some(id))
            .map(|(h, _)| *h)
    }

    /// Start a preview (or return the one there is).
    pub(crate) async fn create_preview(&self, req: PreviewRequest) -> ApiResult<PreviewInfo> {
        let p: Parsed = self.resolve_url(&req.source, req.cookie.as_deref()).await?;
        let hash = p.hash;
        {
            let _ops = self.ops.lock().await;
            if self.state().torrents.contains_key(&hash) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    ErrorCode::Duplicate,
                    format!("torrent {} is already added", hex(&hash)),
                ));
            }
            let exists = {
                let st = self.state();
                if !st.previews.contains_key(&hash) && st.previews.len() >= MAX_PREVIEWS {
                    return Err(ApiError::new(
                        StatusCode::CONFLICT,
                        ErrorCode::Busy,
                        format!("{MAX_PREVIEWS} previews at once at most; delete some"),
                    ));
                }
                st.previews.contains_key(&hash)
            };
            if !exists {
                let (id, metainfo) = match p.source {
                    Source::Metainfo { bytes } => (None, Some(bytes)),
                    Source::Magnet { uri } => {
                        let dir = self.store.root().join("previews");
                        let add = AddTorrent::magnet(uri, dir)
                            .hold_after_metadata(true)
                            .auto_managed(false);
                        (Some(self.session.add_torrent(add).await?), None)
                    }
                };
                self.state().previews.insert(
                    hash,
                    Preview {
                        id,
                        name: p.name,
                        created: now(),
                        touched: Instant::now(),
                        metainfo,
                        error: None,
                    },
                );
            }
        }
        self.preview(&hex(&hash)).await
    }

    fn preview_view(&self, hash: &InfoHash, p: &Preview, peers: Option<u32>) -> PreviewInfo {
        let metadata = p.metainfo.as_deref().and_then(|b| parse_metadata(b).ok());
        let state = if p.error.is_some() {
            PreviewState::Failed
        } else if metadata.is_some() {
            PreviewState::Ready
        } else {
            PreviewState::Fetching
        };
        let left = PREVIEW_TTL.saturating_sub(p.touched.elapsed());
        PreviewInfo {
            hash: hex(hash),
            name: metadata
                .as_ref()
                .map_or_else(|| p.name.clone(), |m| m.name.clone()),
            state,
            created: p.created,
            expires: now() + left.as_secs(),
            peers: if state == PreviewState::Fetching {
                peers
            } else {
                None
            },
            metadata,
            error: p.error.clone(),
        }
    }

    /// One preview (reading it keeps it).
    pub(crate) async fn preview(&self, hash: &str) -> ApiResult<PreviewInfo> {
        let h = parse_hash(hash)
            .ok_or_else(|| ApiError::bad_request(format!("{hash:?} is not an info-hash")))?;
        let id = {
            let mut st = self.state();
            let p = st.previews.get_mut(&h).ok_or_else(|| no_preview(hash))?;
            p.touched = Instant::now();
            p.id
        };
        let peers = match id {
            Some(id) => self
                .session
                .status(id)
                .await
                .ok()
                .map(|s| u32::try_from(s.peers).unwrap_or(u32::MAX)),
            None => None,
        };
        let st = self.state();
        let p = st.previews.get(&h).ok_or_else(|| no_preview(hash))?;
        Ok(self.preview_view(&h, p, peers))
    }

    /// Every preview (reading them keeps them).
    pub(crate) async fn previews(&self) -> ApiResult<Vec<PreviewInfo>> {
        let statuses = self.session.statuses().await?;
        let mut st = self.state();
        let mut out: Vec<PreviewInfo> = st
            .previews
            .iter_mut()
            .map(|(h, p)| {
                p.touched = Instant::now();
                let peers = p.id.and_then(|id| {
                    statuses
                        .iter()
                        .find(|s| s.id == id)
                        .map(|s| u32::try_from(s.peers).unwrap_or(u32::MAX))
                });
                self.preview_view(h, p, peers)
            })
            .collect();
        out.sort_by(|a, b| a.created.cmp(&b.created).then(a.hash.cmp(&b.hash)));
        Ok(out)
    }

    /// A ready preview's `.torrent` (qBittorrent's `saveMetadata`).
    pub(crate) fn preview_file(&self, hash: &str) -> ApiResult<Vec<u8>> {
        let h = parse_hash(hash)
            .ok_or_else(|| ApiError::bad_request(format!("{hash:?} is not an info-hash")))?;
        let mut st = self.state();
        let p = st.previews.get_mut(&h).ok_or_else(|| no_preview(hash))?;
        p.touched = Instant::now();
        p.metainfo
            .clone()
            .ok_or_else(|| ApiError::conflict(format!("the metadata of {hash} is not here yet")))
    }

    /// Drop a preview.
    pub(crate) async fn delete_preview(&self, hash: &str) -> ApiResult<()> {
        let h = parse_hash(hash)
            .ok_or_else(|| ApiError::bad_request(format!("{hash:?} is not an info-hash")))?;
        let _ops = self.ops.lock().await;
        let p = self
            .state()
            .previews
            .remove(&h)
            .ok_or_else(|| no_preview(hash))?;
        self.drop_engine_preview(p.id).await;
        Ok(())
    }

    async fn drop_engine_preview(&self, id: Option<TorrentId>) {
        if let Some(id) = id {
            match self.session.remove_torrent(id).await {
                Ok(()) | Err(urtorrent::Error::NoSuchTorrent) => {}
                Err(e) => tracing::debug!("removing a preview: {e}"),
            }
        }
    }

    /// Taken by an add (the ops lock held): the `.torrent` if it is here;
    /// the engine torrent is removed either way.
    pub(crate) async fn take_preview(&self, hash: &InfoHash) -> Option<Vec<u8>> {
        let p = self.state().previews.remove(hash)?;
        self.drop_engine_preview(p.id).await;
        p.metainfo
    }

    /// `MetadataReceived` for a preview: keep the `.torrent`, drop the engine
    /// torrent. Whether `id` was a preview's.
    pub(crate) async fn preview_metadata(&self, id: TorrentId) -> bool {
        let Some(hash) = self.preview_hash(id) else {
            return false;
        };
        let file = self.session.torrent_file(id).await;
        self.drop_engine_preview(Some(id)).await;
        let mut st = self.state();
        if let Some(p) = st.previews.get_mut(&hash) {
            p.id = None;
            match file {
                Ok(Some(bytes)) => p.metainfo = Some(bytes),
                Ok(None) => p.error = Some("the metadata could not be read".into()),
                Err(e) => p.error = Some(e.to_string()),
            }
        }
        true
    }

    /// `TorrentError` for a preview. Whether `id` was a preview's.
    pub(crate) async fn preview_failed(&self, id: TorrentId, error: &str) -> bool {
        let Some(hash) = self.preview_hash(id) else {
            return false;
        };
        self.drop_engine_preview(Some(id)).await;
        if let Some(p) = self.state().previews.get_mut(&hash) {
            p.id = None;
            p.error = Some(error.to_string());
        }
        true
    }

    /// Drop the previews nobody read for [`PREVIEW_TTL`] (the tick).
    pub(crate) async fn expire_previews(&self) {
        let expired: Vec<Option<TorrentId>> = {
            let mut st = self.state();
            let old: Vec<InfoHash> = st
                .previews
                .iter()
                .filter(|(_, p)| p.touched.elapsed() >= PREVIEW_TTL)
                .map(|(h, _)| *h)
                .collect();
            old.iter()
                .filter_map(|h| st.previews.remove(h))
                .map(|p| p.id)
                .collect()
        };
        for id in expired {
            self.drop_engine_preview(id).await;
        }
    }
}
