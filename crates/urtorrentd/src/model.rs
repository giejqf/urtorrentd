// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Request and response types of the API. Everything here derives
//! `ToSchema`, so the OpenAPI document (and any SDK generated from it) is
//! exactly these types. Units are uniform (AGENTS.md 4.3): bytes, bytes per
//! second, seconds, unix seconds; `null` for unknown or unlimited.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::error::ErrorDetail;
use crate::log::LogLevel;
use crate::store::{Category, ShareLimits, StopCondition};

/// A present field (even `null`) is `Some`, an absent one `None`.
pub(crate) fn patch_field<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

// ---------------------------------------------------------------- selection

/// The literal `"all"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AllTorrents {
    /// Every torrent.
    All,
}

/// Which torrents a bulk action applies to: a list of info-hashes or `"all"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum Hashes {
    /// Every torrent.
    All(AllTorrents),
    /// These info-hashes (40 hex characters).
    List(Vec<String>),
}

/// The outcome of a bulk action.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct BulkResult {
    /// Info-hashes the action was applied to.
    pub applied: Vec<String>,
    /// Requested info-hashes with no torrent.
    pub not_found: Vec<String>,
    /// Torrents where the action failed.
    pub failed: Vec<BulkFailure>,
}

/// One failure in a bulk action.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BulkFailure {
    /// The torrent.
    pub hash: String,
    /// Why.
    pub error: ErrorDetail,
}

/// A bulk action with no parameters.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct HashesRequest {
    /// Target torrents.
    pub hashes: Hashes,
}

/// A bulk action with an on/off value.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ToggleRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// On or off.
    pub value: bool,
}

/// Remove torrents.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct DeleteRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Also delete the downloaded content.
    #[serde(default)]
    pub delete_files: bool,
}

/// Where to move torrents in the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueueMoveTo {
    /// To the front.
    Top,
    /// One place towards the front.
    Up,
    /// One place towards the back.
    Down,
    /// To the back.
    Bottom,
}

/// Move torrents in the queue.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct QueueRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Direction.
    pub to: QueueMoveTo,
}

/// Change per-torrent limits. Absent fields stay; `null` removes the limit.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct LimitsRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Upload limit in bytes per second; `null` = unlimited.
    #[serde(default, deserialize_with = "patch_field")]
    pub upload_limit: Option<Option<u64>>,
    /// Download limit in bytes per second; `null` = unlimited.
    #[serde(default, deserialize_with = "patch_field")]
    pub download_limit: Option<Option<u64>>,
    /// Peer connection cap; `null` = the global per-torrent default.
    #[serde(default, deserialize_with = "patch_field")]
    pub max_connections: Option<Option<u32>>,
    /// Upload slot cap; `null` = only the global budget.
    #[serde(default, deserialize_with = "patch_field")]
    pub max_uploads: Option<Option<u32>>,
}

/// Set share limits.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ShareLimitsRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// The new limits.
    pub share_limits: ShareLimits,
}

/// Move content to a new directory (turns automatic management off).
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct LocationRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Absolute directory.
    pub path: String,
}

/// Set or clear the category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CategoryRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Category name (created if missing); `null` clears it.
    #[schema(required = true)]
    pub category: Option<String>,
}

/// How a tag change applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TagMode {
    /// Add these tags.
    Add,
    /// Remove these tags.
    Remove,
    /// Replace the tag set with these.
    Set,
}

/// Change torrents' tags (missing tags are created).
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct TagsRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// Add, remove or replace.
    pub mode: TagMode,
    /// The tags.
    pub tags: Vec<String>,
}

/// Add peers to torrents.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AddPeersRequest {
    /// Target torrents.
    pub hashes: Hashes,
    /// `ip:port` or `[ipv6]:port`.
    pub peers: Vec<String>,
}

// ---------------------------------------------------------------- adding

/// How the content's top-level folder is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContentLayout {
    /// As the torrent says.
    #[default]
    Original,
    /// Put a single-file torrent in a folder named after it.
    Subfolder,
    /// Drop a multi-file torrent's top-level folder.
    NoSubfolder,
}

/// Options for new torrents. Absent fields use the settings' defaults.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AddOptions {
    /// Save directory (absolute). Ignored with automatic management.
    pub save_path: Option<String>,
    /// Download to this directory first, then move to the save path when
    /// complete. Absent: the global `download_path` setting.
    pub download_path: Option<String>,
    /// Use a download path at all (`false` downloads straight to the save path).
    pub use_download_path: Option<bool>,
    /// Category (created if missing).
    pub category: Option<String>,
    /// Tags (created if missing).
    #[serde(default)]
    pub tags: Vec<String>,
    /// Add stopped. Absent: the `add_stopped` setting.
    pub stopped: Option<bool>,
    /// Start regardless of the queue limits.
    #[serde(default)]
    pub forced: bool,
    /// Put at the front of the queue. Absent: the `add_to_top_of_queue` setting.
    pub add_to_top_of_queue: Option<bool>,
    /// Stop automatically at this point.
    #[serde(default)]
    pub stop_condition: StopCondition,
    /// Top-level folder layout (`.torrent` files only).
    #[serde(default)]
    pub content_layout: ContentLayout,
    /// Display name.
    pub rename: Option<String>,
    /// Upload limit in bytes per second.
    pub upload_limit: Option<u64>,
    /// Download limit in bytes per second.
    pub download_limit: Option<u64>,
    /// Peer connection cap.
    pub max_connections: Option<u32>,
    /// Upload slot cap. Absent: the `max_uploads_per_torrent` setting.
    pub max_uploads: Option<u32>,
    /// Share limits.
    pub share_limits: Option<ShareLimits>,
    /// Automatic management (save path from the category). Absent: the
    /// `auto_management` setting.
    pub auto_management: Option<bool>,
    /// Download pieces in order.
    #[serde(default)]
    pub sequential: bool,
    /// Download the first and last pieces of each file first (previews).
    #[serde(default)]
    pub first_last_piece_priority: bool,
    /// File priorities in file order (0 = skip, 1..=7, higher first; 4 is normal).
    pub file_priorities: Option<Vec<u8>>,
    /// Allocate files at full size. Absent: the `preallocate` setting.
    pub preallocate: Option<bool>,
    /// `Cookie` header sent when fetching URLs.
    pub cookie: Option<String>,
}

/// Add torrents from URLs, magnet links, info-hashes and `.torrent` files.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AddTorrentsRequest {
    /// Magnet links, bare info-hashes, or `http(s)` URLs of `.torrent` files.
    #[serde(default)]
    pub urls: Vec<String>,
    /// `.torrent` files, base64-encoded.
    #[serde(default)]
    #[schema(value_type = Vec<String>, format = Byte)]
    pub torrents: Vec<String>,
    /// Options applied to every torrent in the request.
    #[serde(default)]
    pub options: AddOptions,
}

/// A torrent that was added.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AddedTorrent {
    /// Info-hash.
    pub hash: String,
    /// Name.
    pub name: String,
}

/// A source that could not be added.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AddFailure {
    /// The URL, or `torrents[<index>]`.
    pub source: String,
    /// Info-hash, when it could be determined.
    #[schema(required = true)]
    pub hash: Option<String>,
    /// Why.
    pub error: ErrorDetail,
}

/// The outcome of an add request.
#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct AddTorrentsResponse {
    /// Added torrents.
    pub added: Vec<AddedTorrent>,
    /// Sources that failed.
    pub failed: Vec<AddFailure>,
}

/// A `.torrent` to inspect without adding it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ParseTorrentRequest {
    /// The `.torrent`, base64-encoded.
    #[schema(format = Byte)]
    pub torrent: String,
}

/// A file inside a parsed `.torrent`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct MetadataFile {
    /// Path, `/`-separated, including the top-level folder.
    pub path: String,
    /// Bytes.
    pub size: u64,
}

/// What a `.torrent` contains.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TorrentMetadata {
    /// Info-hash.
    pub hash: String,
    /// Name.
    pub name: String,
    /// Content bytes.
    pub total_size: u64,
    /// Piece length in bytes.
    pub piece_size: u32,
    /// Number of pieces.
    pub pieces: usize,
    /// Private torrent (BEP 27).
    pub private: bool,
    /// Content files (padding files excluded), in file order.
    pub files: Vec<MetadataFile>,
    /// Tracker tiers.
    pub trackers: Vec<Vec<String>>,
    /// Web seed URLs.
    pub web_seeds: Vec<String>,
    /// Comment.
    #[schema(required = true)]
    pub comment: Option<String>,
    /// Creating program.
    #[schema(required = true)]
    pub created_by: Option<String>,
    /// Creation time, unix seconds.
    #[schema(required = true)]
    pub creation_date: Option<i64>,
}

// ---------------------------------------------------------------- listing

/// Filters for the torrent list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TorrentFilter {
    /// Everything.
    #[default]
    All,
    /// Not complete.
    Downloading,
    /// Complete and running.
    Seeding,
    /// Complete.
    Completed,
    /// Stopped.
    Stopped,
    /// Not stopped.
    Running,
    /// Moving payload right now.
    Active,
    /// Not moving payload right now.
    Inactive,
    /// Running but moving no payload.
    Stalled,
    /// Stalled while seeding.
    StalledSeeding,
    /// Stalled while downloading.
    StalledDownloading,
    /// Checking or waiting to check.
    Checking,
    /// Moving storage.
    Moving,
    /// In error.
    Errored,
}

/// Sort keys for the torrent list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TorrentSort {
    /// Name.
    Name,
    /// Wanted size.
    Size,
    /// Progress.
    Progress,
    /// Download rate.
    DownloadRate,
    /// Upload rate.
    UploadRate,
    /// Time added.
    AddedOn,
    /// Time completed.
    CompletedOn,
    /// Share ratio.
    Ratio,
    /// Queue position.
    QueuePosition,
    /// State.
    State,
    /// Uploaded bytes.
    Uploaded,
    /// Downloaded bytes.
    Downloaded,
    /// Estimated time left.
    Eta,
    /// Category.
    Category,
}

/// Query parameters of the torrent list.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TorrentListQuery {
    /// State filter.
    pub filter: Option<TorrentFilter>,
    /// Only this category (`""` = torrents without one).
    pub category: Option<String>,
    /// Only torrents with this tag (`""` = torrents without tags).
    pub tag: Option<String>,
    /// Only these info-hashes, `|`-separated.
    pub hashes: Option<String>,
    /// Only private (`true`) or public (`false`) torrents.
    pub private: Option<bool>,
    /// Sort key.
    pub sort: Option<TorrentSort>,
    /// Sort descending.
    pub reverse: Option<bool>,
    /// Page size.
    pub limit: Option<usize>,
    /// Page start.
    pub offset: Option<usize>,
}

/// A torrent's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TorrentState {
    /// A magnet link fetching its metadata.
    Metadata,
    /// Waiting for a checking slot.
    CheckingQueued,
    /// Checking the files on disk.
    Checking,
    /// Downloading (or looking for peers).
    Downloading,
    /// Complete and seeding.
    Seeding,
    /// Waiting for an active slot in the queue.
    Queued,
    /// Stopped.
    Stopped,
    /// Stopped by an error (see `error`).
    Error,
    /// Moving its content to a new directory.
    Moving,
    /// Its metadata is known and it waits (no files created yet): a stop
    /// condition fired, or the daemon is applying add options.
    Held,
    /// A state newer than this daemon knows.
    Unknown,
}

/// What stopped a torrent in the `error` state, and so what brings it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TorrentErrorKind {
    /// Its files are gone (moved, deleted, a drive not mounted). `start`
    /// looks again once they are back; `recheck` accepts what the disk holds
    /// and downloads the rest.
    ContentMissing,
    /// Reading, writing or checking failed (disk full, permissions). `start`
    /// restarts; `recheck` rechecks.
    Io,
    /// The metadata cannot be used. Only removing the torrent helps.
    Metadata,
    /// Something newer than this daemon knows.
    Other,
}

/// One row of the torrent list.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct TorrentSummary {
    /// Info-hash (lowercase hex).
    pub hash: String,
    /// Display name.
    pub name: String,
    /// State.
    pub state: TorrentState,
    /// Running but moving no payload.
    pub stalled: bool,
    /// Started regardless of the queue limits.
    pub forced: bool,
    /// Every wanted piece is verified.
    pub complete: bool,
    /// Error text in the `error` state.
    #[schema(required = true)]
    pub error: Option<String>,
    /// What kind of error, in the `error` state.
    #[schema(required = true)]
    pub error_kind: Option<TorrentErrorKind>,
    /// Progress over the wanted bytes, 0..=1.
    pub progress: f64,
    /// Wanted bytes (files not skipped).
    pub size: u64,
    /// All content bytes.
    pub total_size: u64,
    /// Wanted bytes verified.
    pub completed: u64,
    /// Wanted bytes still missing.
    pub left: u64,
    /// Payload bytes downloaded, all time (includes wasted bytes).
    pub downloaded: u64,
    /// Payload bytes uploaded, all time.
    pub uploaded: u64,
    /// Payload bytes downloaded since the daemon started.
    pub downloaded_session: u64,
    /// Payload bytes uploaded since the daemon started.
    pub uploaded_session: u64,
    /// Bytes that failed hash checks or arrived redundantly.
    pub wasted: u64,
    /// Upload / download ratio; `null` when nothing counts as downloaded yet.
    #[schema(required = true)]
    pub ratio: Option<f64>,
    /// Bytes per second.
    pub download_rate: u64,
    /// Bytes per second.
    pub upload_rate: u64,
    /// Seconds until complete at the current rate; `null` when unknown.
    #[schema(required = true)]
    pub eta: Option<u64>,
    /// Bytes per second; `null` = unlimited.
    #[schema(required = true)]
    pub download_limit: Option<u64>,
    /// Bytes per second; `null` = unlimited.
    #[schema(required = true)]
    pub upload_limit: Option<u64>,
    /// Peer connection cap in force.
    pub max_connections: usize,
    /// Upload slot cap; `null` = only the global budget.
    #[schema(required = true)]
    pub max_uploads: Option<usize>,
    /// Connected peers.
    pub peers: usize,
    /// Connected peers that are seeds.
    pub seeds: usize,
    /// Seeds in the swarm as trackers report it.
    #[schema(required = true)]
    pub swarm_seeds: Option<u32>,
    /// Leechers in the swarm as trackers report it.
    #[schema(required = true)]
    pub swarm_leechers: Option<u32>,
    /// Distributed copies among the connected peers and us (libtorrent's
    /// `distributed_copies`); `null` for a complete seed or before the
    /// metadata.
    #[schema(required = true)]
    pub availability: Option<f64>,
    /// Where the content belongs.
    pub save_path: String,
    /// Where the content lives until it is complete, if elsewhere.
    #[schema(required = true)]
    pub download_path: Option<String>,
    /// The content's path on disk (the file, or the top-level folder); `null`
    /// before the metadata is known.
    #[schema(required = true)]
    pub content_path: Option<String>,
    /// The top-level folder on disk; `null` for single files.
    #[schema(required = true)]
    pub root_path: Option<String>,
    /// Category.
    #[schema(required = true)]
    pub category: Option<String>,
    /// Tags.
    pub tags: Vec<String>,
    /// Unix seconds.
    pub added_on: u64,
    /// Unix seconds.
    #[schema(required = true)]
    pub completed_on: Option<u64>,
    /// Last time payload moved, unix seconds.
    #[schema(required = true)]
    pub last_activity: Option<u64>,
    /// Last time a complete copy was seen, unix seconds.
    #[schema(required = true)]
    pub seen_complete: Option<u64>,
    /// Seconds running, all time.
    pub active_time: u64,
    /// Seconds running while complete, all time.
    pub seeding_time: u64,
    /// Position in the queue (0 = first).
    pub queue_position: usize,
    /// Automatic management: the save path follows the category.
    pub auto_management: bool,
    /// Pieces are downloaded in order.
    pub sequential: bool,
    /// The first and last pieces of each wanted file come first.
    pub first_last_piece_priority: bool,
    /// Private torrent (BEP 27).
    pub private: bool,
    /// The metadata is known.
    pub has_metadata: bool,
    /// Piece length in bytes (0 before the metadata).
    pub piece_size: u32,
    /// Verified pieces.
    pub pieces_have: usize,
    /// All pieces.
    pub pieces_total: usize,
    /// The tracker currently working; `null` if none is.
    #[schema(required = true)]
    pub tracker: Option<String>,
    /// Trackers configured.
    pub trackers_count: usize,
    /// Magnet link.
    pub magnet_uri: String,
    /// Comment.
    #[schema(required = true)]
    pub comment: Option<String>,
    /// Creating program.
    #[schema(required = true)]
    pub created_by: Option<String>,
    /// Creation time, unix seconds.
    #[schema(required = true)]
    pub creation_date: Option<i64>,
    /// Share limits.
    pub share_limits: ShareLimits,
    /// Ratio per month of active time; `null` when not computable.
    #[schema(required = true)]
    pub popularity: Option<f64>,
    /// Seconds until the next tracker announce.
    #[schema(required = true)]
    pub next_announce_in: Option<u64>,
}

/// Everything about one torrent.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct TorrentDetail {
    /// The list row.
    #[serde(flatten)]
    pub summary: TorrentSummary,
    /// Web seed URLs.
    pub web_seeds: Vec<String>,
    /// Peer addresses known (connected or waiting to be dialled).
    pub known_peers: usize,
    /// The URL the torrent was added from.
    #[schema(required = true)]
    pub source_url: Option<String>,
}

/// Change a torrent's display name or comment. Absent fields stay; `null`
/// restores the torrent's own value.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TorrentPatch {
    /// Display name.
    #[serde(default, deserialize_with = "patch_field")]
    pub name: Option<Option<String>>,
    /// Comment.
    #[serde(default, deserialize_with = "patch_field")]
    pub comment: Option<Option<String>>,
}

/// How many torrents there are.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct CountResponse {
    /// Torrents.
    pub count: usize,
}

// ---------------------------------------------------------------- per-torrent detail

/// One content file.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileInfo {
    /// Index (file order; padding files are not listed).
    pub index: usize,
    /// Path relative to the save path, `/`-separated.
    pub path: String,
    /// Bytes.
    pub size: u64,
    /// Verified fraction, 0..=1.
    pub progress: f64,
    /// 0 = skip, 1..=7, higher first; 4 is normal.
    pub priority: u8,
    /// First piece the file touches.
    pub first_piece: u32,
    /// Last piece the file touches.
    pub last_piece: u32,
    /// Fraction of the file's pieces that we or a connected peer have.
    pub availability: f64,
}

/// Set file priorities.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct FilePriorityRequest {
    /// File indexes.
    pub indexes: Vec<usize>,
    /// 0 = skip, 1..=7, higher first; 4 is normal.
    #[schema(maximum = 7)]
    pub priority: u8,
}

/// Rename a file or folder inside a torrent.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct RenameRequest {
    /// Current path relative to the save path.
    pub old_path: String,
    /// New path relative to the save path.
    pub new_path: String,
}

/// A tracker's standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TrackerStatus {
    /// Not announced to yet.
    NotContacted,
    /// The last announce succeeded.
    Working,
    /// The last announce failed.
    NotWorking,
    /// An announce is in flight.
    Updating,
}

/// A tracker as announced through one listen socket.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrackerEndpointInfo {
    /// The local listen address announced from (unspecified when listening
    /// on every address of the family).
    pub local: String,
    /// The last announce through it succeeded.
    pub working: bool,
    /// An announce through it is in flight.
    pub updating: bool,
    /// Consecutive failures.
    pub fails: u32,
    /// The last error, if any.
    #[schema(required = true)]
    pub message: Option<String>,
    /// Seeders reported to this endpoint.
    #[schema(required = true)]
    pub seeders: Option<u32>,
    /// Leechers reported to this endpoint.
    #[schema(required = true)]
    pub leechers: Option<u32>,
    /// Seconds until its next announce.
    #[schema(required = true)]
    pub next_announce_in: Option<u64>,
}

/// One tracker.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrackerInfo {
    /// Announce URL.
    pub url: String,
    /// Tier (0 first).
    pub tier: usize,
    /// Standing.
    pub status: TrackerStatus,
    /// The last error, if any.
    #[schema(required = true)]
    pub message: Option<String>,
    /// Consecutive failures.
    pub fails: u32,
    /// Seeders the tracker reports.
    #[schema(required = true)]
    pub seeders: Option<u32>,
    /// Leechers the tracker reports.
    #[schema(required = true)]
    pub leechers: Option<u32>,
    /// Completed downloads the tracker reports.
    #[schema(required = true)]
    pub downloaded: Option<u32>,
    /// Seconds until the next announce.
    #[schema(required = true)]
    pub next_announce_in: Option<u64>,
    /// An announce is in flight (any endpoint).
    pub updating: bool,
    /// The tracker per listen socket (it is announced once per socket).
    pub endpoints: Vec<TrackerEndpointInfo>,
}

/// A trackerless peer source.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PeerSourceInfo {
    /// In use for this torrent (off in the settings or for private torrents).
    pub enabled: bool,
    /// Connected peers found through it.
    pub peers: usize,
}

/// A torrent's trackers and trackerless peer sources.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrackersResponse {
    /// Trackers in tier order.
    pub trackers: Vec<TrackerInfo>,
    /// The DHT.
    pub dht: PeerSourceInfo,
    /// Peer exchange.
    pub pex: PeerSourceInfo,
    /// Local service discovery.
    pub lsd: PeerSourceInfo,
}

/// Add trackers.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AddTrackersRequest {
    /// Announce URLs.
    pub urls: Vec<String>,
    /// Tier; absent = a new tier after the last.
    pub tier: Option<usize>,
}

/// URLs to remove.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct UrlsRequest {
    /// URLs.
    pub urls: Vec<String>,
}

/// Replace one URL with another.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct EditUrlRequest {
    /// Current URL.
    pub url: String,
    /// New URL.
    pub new_url: String,
}

/// How a peer was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeerSource {
    /// A tracker.
    Tracker,
    /// Added by hand.
    Manual,
    /// Peer exchange.
    Pex,
    /// Local service discovery.
    Lsd,
    /// It connected to us.
    Incoming,
    /// The DHT.
    Dht,
    /// Remembered from the last run.
    Resume,
    /// Something newer than this daemon knows.
    Other,
}

/// A peer transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeerTransport {
    /// TCP.
    Tcp,
    /// uTP.
    Utp,
    /// Something newer than this daemon knows.
    Other,
}

/// A connected peer.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PeerInfo {
    /// `ip:port`.
    pub address: String,
    /// How it was found.
    pub source: PeerSource,
    /// It connected to us.
    pub incoming: bool,
    /// Transport.
    pub transport: PeerTransport,
    /// RC4-encrypted (MSE).
    pub encrypted: bool,
    /// Client name from its handshake.
    #[schema(required = true)]
    pub client: Option<String>,
    /// Its peer id, hex.
    #[schema(required = true)]
    pub peer_id: Option<String>,
    /// Fraction of the pieces it has.
    pub progress: f64,
    /// It has every piece.
    pub is_seed: bool,
    /// It only uploads.
    pub upload_only: bool,
    /// Payload bytes received from it.
    pub downloaded: u64,
    /// Payload bytes sent to it.
    pub uploaded: u64,
    /// Bytes per second from it.
    pub download_rate: u64,
    /// Bytes per second to it.
    pub upload_rate: u64,
    /// It is choking us.
    pub peer_choking: bool,
    /// We are choking it.
    pub am_choking: bool,
    /// It wants our data.
    pub peer_interested: bool,
    /// We want its data.
    pub am_interested: bool,
    /// Our requests outstanding to it.
    pub outstanding_requests: usize,
    /// Seconds connected.
    pub connected_for: u64,
}

/// A piece's standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PieceState {
    /// Not verified, not in progress.
    Missing,
    /// Blocks in flight or received, not yet verified.
    Downloading,
    /// Verified.
    Have,
}

/// Every piece's state and availability.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PiecesResponse {
    /// Piece states in piece order.
    pub states: Vec<PieceState>,
    /// Connected peers (and web seeds) with each piece, in piece order.
    pub availability: Vec<u32>,
    /// Download priority of each piece (0 = skipped, 1..=7), in piece order.
    pub priorities: Vec<u8>,
}

// ---------------------------------------------------------------- categories and tags

/// Create or edit a category.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CategoryDefinition {
    /// Name (`/` separates subcategories).
    pub name: String,
    /// The category.
    #[serde(flatten)]
    pub category: Category,
}

/// Names to remove.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct NamesRequest {
    /// Names.
    pub names: Vec<String>,
}

/// Tags to create or delete.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct TagListRequest {
    /// Tags.
    pub tags: Vec<String>,
}

// ---------------------------------------------------------------- transfer, app, logs

/// Whether peers can reach us.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    /// Peers have connected to us.
    Connected,
    /// Listening, but no peer has connected to us yet.
    Firewalled,
}

/// Session-wide transfer state.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct TransferInfo {
    /// Bytes per second, all torrents.
    pub download_rate: u64,
    /// Bytes per second, all torrents.
    pub upload_rate: u64,
    /// Payload bytes since the daemon started.
    pub downloaded_session: u64,
    /// Payload bytes since the daemon started.
    pub uploaded_session: u64,
    /// Payload bytes, all time.
    pub downloaded_total: u64,
    /// Payload bytes, all time.
    pub uploaded_total: u64,
    /// All-time upload / download ratio; `null` before any download.
    #[schema(required = true)]
    pub ratio: Option<f64>,
    /// Global download limit in force, bytes per second; `null` = unlimited.
    #[schema(required = true)]
    pub download_limit: Option<u64>,
    /// Global upload limit in force, bytes per second; `null` = unlimited.
    #[schema(required = true)]
    pub upload_limit: Option<u64>,
    /// The alternative limits are in force.
    pub alt_speed_enabled: bool,
    /// Whether peers can reach us.
    pub connection_status: ConnectionStatus,
    /// The peer listen port in use.
    pub listen_port: u16,
    /// Connected peers.
    pub peers: usize,
    /// Peer connections, including dials in progress.
    pub connections: usize,
    /// Nodes in the DHT routing table.
    pub dht_nodes: usize,
    /// External IPv4 address as peers and trackers see it.
    #[schema(required = true)]
    pub external_v4: Option<String>,
    /// External IPv6 address as peers and trackers see it.
    #[schema(required = true)]
    pub external_v6: Option<String>,
    /// Free bytes on the default save path's file system.
    #[schema(required = true)]
    pub free_space: Option<u64>,
    /// Disk jobs waiting.
    pub disk_jobs_pending: usize,
}

/// Switch the alternative limits on or off.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct AltSpeedRequest {
    /// Use the alternative limits.
    pub enabled: bool,
}

/// Ban peers.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct BanRequest {
    /// Addresses (`ip`, `ip:port` or `[ipv6]:port`; the port is ignored).
    pub peers: Vec<String>,
}

/// About the daemon.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AppInfo {
    /// Daemon version.
    pub version: String,
    /// API version (the base path's).
    pub api_version: String,
    /// The torrent library and its version.
    pub library: String,
    /// Process id.
    pub pid: u32,
    /// Start time, unix seconds.
    pub started_at: u64,
    /// The data directory.
    pub data_dir: String,
    /// The default save path.
    pub default_save_path: String,
    /// The peer listen port in use.
    pub listen_port: u16,
    /// Settings changed since the start that apply only after a restart.
    pub restart_required: Vec<String>,
}

/// What a directory listing includes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryMode {
    /// Directories and files.
    #[default]
    All,
    /// Directories only.
    Dirs,
    /// Files only.
    Files,
}

/// Query of a directory listing.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DirectoryQuery {
    /// Absolute directory.
    pub path: String,
    /// What to include.
    pub mode: Option<DirectoryMode>,
}

/// A directory entry.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DirectoryEntry {
    /// Name.
    pub name: String,
    /// Absolute path.
    pub path: String,
    /// A directory.
    pub is_dir: bool,
}

/// Change the login.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct CredentialsRequest {
    /// New user name.
    pub username: String,
    /// New password (at least 8 characters).
    pub password: String,
}

/// Log in.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct LoginRequest {
    /// User name.
    pub username: String,
    /// Password.
    pub password: String,
}

/// A new API key (shown once; only its hash is stored).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ApiKeyResponse {
    /// Send as `Authorization: Bearer <key>`.
    pub api_key: String,
}

/// Query of the main log.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct LogQuery {
    /// Only entries with a greater id.
    pub after: Option<u64>,
    /// Only these levels, comma-separated (`info,warning,error`); all when absent.
    pub levels: Option<String>,
}

/// Query of the peer log.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PeerLogQuery {
    /// Only entries with a greater id.
    pub after: Option<u64>,
}

/// Parse a `levels` query value.
pub fn parse_levels(s: Option<&str>) -> Result<Vec<LogLevel>, String> {
    let Some(s) = s else {
        return Ok(Vec::new());
    };
    s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(|x| match x {
            "info" => Ok(LogLevel::Info),
            "warning" => Ok(LogLevel::Warning),
            "error" => Ok(LogLevel::Error),
            other => Err(format!("unknown log level {other:?}")),
        })
        .collect()
}

// ---------------------------------------------------------------- sync

/// Query of the sync endpoint.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct SyncQuery {
    /// The `rev` of the last response this client applied; absent (or too
    /// old) returns everything.
    pub rev: Option<u64>,
}

/// Changes since a revision. With `full`, the maps hold everything and the
/// client replaces its state; otherwise they hold only what changed and the
/// `*_removed` lists say what went away. Torrents and categories are sent
/// whole whenever any field changed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SyncResponse {
    /// Pass this as `rev` next time.
    pub rev: u64,
    /// This is a full state, not a diff.
    pub full: bool,
    /// Torrents added or changed, by info-hash.
    pub torrents: BTreeMap<String, TorrentSummary>,
    /// Info-hashes of torrents removed.
    pub torrents_removed: Vec<String>,
    /// Categories added or changed.
    pub categories: BTreeMap<String, Category>,
    /// Categories removed.
    pub categories_removed: Vec<String>,
    /// The full tag list, when it changed (always with `full`).
    #[schema(required = true)]
    pub tags: Option<Vec<String>>,
    /// Session-wide transfer state (always sent).
    pub transfer: TransferInfo,
}
