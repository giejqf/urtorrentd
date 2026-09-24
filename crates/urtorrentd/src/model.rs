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
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ToSchema)]
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
    /// Stop automatically at this point. Absent: the `stop_condition`
    /// setting.
    pub stop_condition: Option<StopCondition>,
    /// Top-level folder layout. Absent: the `content_layout` setting.
    pub content_layout: Option<ContentLayout>,
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
    /// Its country (ISO 3166-1 alpha-2) from the GeoIP database; `null` =
    /// no database, or not in it.
    #[schema(required = true)]
    pub country: Option<String>,
    /// Its autonomous system number; `null` = unknown.
    #[schema(required = true)]
    pub asn: Option<u32>,
    /// Its autonomous system's organization; `null` = unknown.
    #[schema(required = true)]
    pub as_org: Option<String>,
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
    /// The GeoIP databases in use.
    pub geoip: GeoIpInfo,
    /// The `instance_name` setting.
    #[schema(required = true)]
    pub instance_name: Option<String>,
    /// The addresses listened on (and peers dialled from).
    pub listen_addresses: Vec<String>,
    /// The trackers fetched from `add_trackers_url`; `null` = none set.
    #[schema(required = true)]
    pub fetched_trackers: Option<FetchedTrackers>,
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

/// Query of the event stream.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct EventsQuery {
    /// Resume after this revision (a `Last-Event-ID` header wins); absent
    /// starts with everything.
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

// ---- Statistics (`/stats`, ADR 0005) ----

/// The bucket size of a statistics series. Each bucket is named by its start
/// (`t`, unix seconds, aligned to UTC minutes, hours or days).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StatsStep {
    /// 60 seconds.
    Minute,
    /// 3600 seconds.
    Hour,
    /// 86400 seconds (UTC days).
    Day,
}

/// The time range of a statistics series.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StatsRangeQuery {
    /// Buckets starting at or after this time, unix seconds; default: one
    /// day before `to`.
    pub from: Option<u64>,
    /// Buckets starting at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// Bucket size; default: the finest one kept for the whole range, with
    /// at most 10 000 buckets.
    pub step: Option<StatsStep>,
}

/// A period in which statistics were recorded: the daemon ran with
/// `stats_enabled` on. Outside every period nothing is known (the daemon was
/// down or recording was off); inside one, a missing bucket means nothing
/// moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct StatsPeriod {
    /// When recording started, unix seconds.
    pub started: u64,
    /// When it ended, unix seconds; `null` = still recording.
    #[schema(required = true)]
    pub ended: Option<u64>,
    /// Ended by a shutdown or by turning recording off (`true` while still
    /// recording). `false`: the daemon stopped abruptly and `ended` is its
    /// last write (up to a minute early).
    pub clean: bool,
}

/// Session-wide traffic in one bucket. Bytes are payload, as in
/// `TransferInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TransferPoint {
    /// Bucket start, unix seconds.
    pub t: u64,
    /// Bytes downloaded in the bucket.
    pub downloaded: u64,
    /// Bytes uploaded in the bucket.
    pub uploaded: u64,
    /// Most peers connected at one observation (every 2 s).
    pub peers_max: u32,
    /// Most connections (peers plus dials in progress) at one observation.
    pub connections_max: u32,
    /// Most DHT nodes known at one observation.
    pub dht_nodes_max: u32,
    /// Most torrents in the session at one observation.
    pub torrents_max: u32,
}

/// Session-wide traffic over time.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TransferStats {
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Buckets in which the session was recorded, oldest first.
    pub points: Vec<TransferPoint>,
    /// Recording periods overlapping the range, oldest first.
    pub periods: Vec<StatsPeriod>,
}

/// One torrent's traffic in one bucket. Buckets in which nothing moved are
/// left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TrafficPoint {
    /// Bucket start, unix seconds.
    pub t: u64,
    /// Payload bytes downloaded in the bucket.
    pub downloaded: u64,
    /// Payload bytes uploaded in the bucket.
    pub uploaded: u64,
    /// Most peers connected at one observation (every 2 s).
    pub peers_max: u32,
    /// Most seeds connected at one observation (every 2 s).
    pub seeds_max: u32,
}

/// One torrent's traffic over time.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TorrentTraffic {
    /// Info-hash.
    pub hash: String,
    /// Name as last recorded.
    #[schema(required = true)]
    pub name: Option<String>,
    /// When the torrent was removed, unix seconds; `null` = still in the
    /// session (or removed while recording was off).
    #[schema(required = true)]
    pub removed: Option<u64>,
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Buckets in which data moved, oldest first.
    pub points: Vec<TrafficPoint>,
    /// Recording periods overlapping the range, oldest first.
    pub periods: Vec<StatsPeriod>,
}

/// One torrent's day (UTC): its seeding history. A day is recorded when the
/// torrent was running or moved data.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct TorrentDay {
    /// Day start, unix seconds (00:00 UTC).
    pub t: u64,
    /// Payload bytes downloaded that day.
    pub downloaded: u64,
    /// Payload bytes uploaded that day.
    pub uploaded: u64,
    /// Most peers connected at one observation (every 2 s).
    pub peers_max: u32,
    /// Most seeds connected at one observation (every 2 s).
    pub seeds_max: u32,
    /// Seconds the torrent was running that day.
    pub active_time: u64,
    /// Seconds it was seeding that day.
    pub seeding_time: u64,
    /// All-time bytes downloaded at the day's last observation.
    pub downloaded_total: u64,
    /// All-time bytes uploaded at the day's last observation.
    pub uploaded_total: u64,
    /// All-time seconds running at the day's last observation.
    pub active_time_total: u64,
    /// All-time seconds seeding at the day's last observation.
    pub seeding_time_total: u64,
    /// Share ratio at the day's last observation (as `ratio` in the torrent
    /// list); `null` = nothing to divide by.
    #[schema(required = true)]
    pub ratio: Option<f64>,
    /// Most seeders the trackers reported for the swarm; `null` = no report.
    #[schema(required = true)]
    pub swarm_seeds_max: Option<u32>,
    /// Most leechers the trackers reported for the swarm; `null` = no report.
    #[schema(required = true)]
    pub swarm_leechers_max: Option<u32>,
    /// Most completed downloads a scrape reported for the swarm; `null` = no
    /// scrape (they run only with `stats_scrape_interval`).
    #[schema(required = true)]
    pub swarm_completed_max: Option<u32>,
}

/// One torrent's days.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TorrentDays {
    /// Info-hash.
    pub hash: String,
    /// Name as last recorded.
    #[schema(required = true)]
    pub name: Option<String>,
    /// When the torrent was removed, unix seconds; `null` = still in the
    /// session (or removed while recording was off).
    #[schema(required = true)]
    pub removed: Option<u64>,
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// Recorded days, oldest first.
    pub days: Vec<TorrentDay>,
}

/// What torrents are ranked by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TopMetric {
    /// Bytes uploaded in the range.
    Uploaded,
    /// Bytes downloaded in the range.
    Downloaded,
}

/// Query of the torrent ranking.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TopQuery {
    /// Range start, unix seconds; default: one day before `to`.
    pub from: Option<u64>,
    /// Range end, unix seconds; default: now.
    pub to: Option<u64>,
    /// Ranked by; default `uploaded`.
    pub by: Option<TopMetric>,
    /// At most this many torrents (1 to 1000); default 10.
    pub limit: Option<u32>,
}

/// A torrent's traffic over a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TopTorrent {
    /// Info-hash.
    pub hash: String,
    /// Name as last recorded.
    #[schema(required = true)]
    pub name: Option<String>,
    /// When the torrent was removed, unix seconds; `null` = still in the
    /// session (or removed while recording was off).
    #[schema(required = true)]
    pub removed: Option<u64>,
    /// Payload bytes downloaded in the range.
    pub downloaded: u64,
    /// Payload bytes uploaded in the range.
    pub uploaded: u64,
}

/// Torrents ranked by their traffic over a range (removed ones included).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TopTorrents {
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The buckets summed (the finest kept for the whole range); the range
    /// is widened to whole buckets.
    pub step: StatsStep,
    /// Highest first; torrents that moved nothing are left out.
    pub torrents: Vec<TopTorrent>,
}

/// What happened to a torrent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    /// Added.
    Added,
    /// A magnet link's metadata arrived.
    Metadata,
    /// Every wanted piece is downloaded.
    Finished,
    /// The content moved (`detail`: the new directory).
    Moved,
    /// It stopped with an error (`detail`: the message).
    Error,
    /// Removed.
    Removed,
    /// Its state changed to `state` (checking states are not recorded).
    State,
}

/// Query of the timeline.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TimelineQuery {
    /// One torrent (info-hash); default: all.
    pub hash: Option<String>,
    /// Events at or after this time, unix seconds; default: all.
    pub from: Option<u64>,
    /// Events at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// At most this many events, the newest (1 to 10 000); default 100.
    pub limit: Option<u32>,
}

/// An event of a torrent's life.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TimelineEvent {
    /// When, unix seconds.
    pub t: u64,
    /// Info-hash.
    pub hash: String,
    /// The torrent's name as last recorded.
    #[schema(required = true)]
    pub name: Option<String>,
    /// What happened.
    pub kind: TimelineKind,
    /// The new state (`kind` = `state`).
    #[schema(required = true)]
    pub state: Option<TorrentState>,
    /// The new directory (`moved`) or the error (`error`).
    #[schema(required = true)]
    pub detail: Option<String>,
}

/// What the statistics database holds.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StatsInfo {
    /// Recording is on (`stats_enabled`).
    pub enabled: bool,
    /// Size of the database file, bytes.
    pub size: u64,
    /// Torrents with history, removed ones included.
    pub torrents: u64,
    /// Oldest per-minute bucket kept, unix seconds; `null` = none.
    #[schema(required = true)]
    pub oldest_minute: Option<u64>,
    /// Oldest per-hour bucket kept, unix seconds; `null` = none.
    #[schema(required = true)]
    pub oldest_hour: Option<u64>,
    /// Oldest day kept, unix seconds; `null` = none.
    #[schema(required = true)]
    pub oldest_day: Option<u64>,
}

/// A GeoIP database file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GeoDatabaseInfo {
    /// The file.
    pub path: String,
    /// Its `database_type` (`GeoLite2-Country`, `DBIP-Country-Lite`, ...);
    /// `null` = not loaded.
    #[schema(required = true)]
    pub database_type: Option<String>,
    /// When it was built, unix seconds; `null` = not loaded.
    #[schema(required = true)]
    pub built: Option<u64>,
    /// Why it could not be read (at the start, or the last reload; a failed
    /// reload keeps the database read before).
    #[schema(required = true)]
    pub error: Option<String>,
}

/// The GeoIP databases (settings `geoip_database`, `geoip_asn_database`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GeoIpInfo {
    /// The country database; `null` = none configured.
    #[schema(required = true)]
    pub country: Option<GeoDatabaseInfo>,
    /// The ASN database; `null` = none configured.
    #[schema(required = true)]
    pub asn: Option<GeoDatabaseInfo>,
}

/// What peer traffic is grouped by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GeoDimension {
    /// The peer's country.
    Country,
    /// The peer's autonomous system (its network operator).
    Asn,
}

/// Query of peer traffic by place.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct GeoQuery {
    /// Grouped by; default `country`.
    pub dim: Option<GeoDimension>,
    /// One torrent (info-hash); default: all.
    pub hash: Option<String>,
    /// Buckets starting at or after this time, unix seconds; default: one
    /// day before `to`.
    pub from: Option<u64>,
    /// Buckets starting at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// `hour` or `day`; default: the finest kept for the whole range.
    pub step: Option<StatsStep>,
    /// Ranked by; default `uploaded`.
    pub by: Option<TopMetric>,
    /// At most this many places (1 to 250); default 20.
    pub limit: Option<u32>,
    /// Also return each place's buckets (`points`); default false.
    pub series: Option<bool>,
}

/// Traffic with a place over a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GeoRow {
    /// The country (`dim` = `country`); `null` = not located.
    #[schema(required = true)]
    pub country: Option<String>,
    /// The autonomous system (`dim` = `asn`); `null` = not located.
    #[schema(required = true)]
    pub asn: Option<u32>,
    /// The autonomous system's organization, as last seen.
    #[schema(required = true)]
    pub as_org: Option<String>,
    /// Payload bytes received from its peers.
    pub downloaded: u64,
    /// Payload bytes sent to its peers.
    pub uploaded: u64,
    /// The most of its peers that moved data in one bucket (distinct
    /// addresses per torrent, summed over torrents).
    pub peers_max: u32,
}

/// Traffic with a place in one bucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GeoPoint {
    /// Bucket start, unix seconds.
    pub t: u64,
    /// The country (`dim` = `country`).
    #[schema(required = true)]
    pub country: Option<String>,
    /// The autonomous system (`dim` = `asn`).
    #[schema(required = true)]
    pub asn: Option<u32>,
    /// Payload bytes received.
    pub downloaded: u64,
    /// Payload bytes sent.
    pub uploaded: u64,
    /// Its peers that moved data in the bucket (distinct addresses per
    /// torrent, summed over torrents).
    pub peers: u32,
}

/// Bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct ByteTotals {
    /// Payload bytes received.
    pub downloaded: u64,
    /// Payload bytes sent.
    pub uploaded: u64,
}

/// Peer traffic by place. Rows plus `unattributed` add up to the torrents'
/// traffic in the range.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GeoStats {
    /// The torrent, or `null` for all.
    #[schema(required = true)]
    pub hash: Option<String>,
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Grouped by.
    pub dim: GeoDimension,
    /// Places, highest first (not located: `country` / `asn` `null`).
    pub rows: Vec<GeoRow>,
    /// Their buckets, oldest first (`series=true`).
    pub points: Vec<GeoPoint>,
    /// Traffic not tied to a peer: web seeds, and connections whose end
    /// was missed. Peer traffic is sampled every 10 s, so the last seconds
    /// of an ongoing transfer show here until the next sample.
    pub unattributed: ByteTotals,
    /// A GeoIP database is loaded now.
    pub located: bool,
}

/// What peer traffic is broken down by (besides place: `/stats/geo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeerDimension {
    /// The client, without its version (`qBittorrent`).
    Client,
    /// How the peer was found: `tracker`, `dht`, `pex`, `lsd`, `incoming`,
    /// `manual`, `resume`.
    Source,
    /// `tcp` or `utp`.
    Transport,
    /// `rc4` (MSE) or `plaintext`.
    Encryption,
    /// `ipv4` or `ipv6`.
    IpVersion,
    /// Who connected: `incoming` or `outgoing`.
    Direction,
}

/// Query of a peer traffic breakdown.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PeerQuery {
    /// Broken down by.
    pub dim: PeerDimension,
    /// One torrent (info-hash); default: all.
    pub hash: Option<String>,
    /// Buckets starting at or after this time, unix seconds; default: one
    /// day before `to`.
    pub from: Option<u64>,
    /// Buckets starting at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// `hour` or `day`; default: the finest kept for the whole range.
    pub step: Option<StatsStep>,
    /// Ranked by; default `uploaded`.
    pub by: Option<TopMetric>,
    /// At most this many values (1 to 250); default 20.
    pub limit: Option<u32>,
    /// Also return each value's buckets (`points`); default false.
    pub series: Option<bool>,
}

/// Peer traffic with one value over a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PeerRow {
    /// The value (`qBittorrent`, `dht`, `utp`, ...); `null` = unknown (a
    /// peer that sent no client name).
    #[schema(required = true)]
    pub key: Option<String>,
    /// Payload bytes received from its peers.
    pub downloaded: u64,
    /// Payload bytes sent to its peers.
    pub uploaded: u64,
    /// The most of its peers that moved data in one bucket (distinct
    /// addresses per torrent, summed over torrents).
    pub peers_max: u32,
}

/// Peer traffic with one value in one bucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PeerPoint {
    /// Bucket start, unix seconds.
    pub t: u64,
    /// The value.
    #[schema(required = true)]
    pub key: Option<String>,
    /// Payload bytes received.
    pub downloaded: u64,
    /// Payload bytes sent.
    pub uploaded: u64,
    /// Its peers that moved data in the bucket.
    pub peers: u32,
}

/// Peer traffic broken down. Rows plus `unattributed` add up to the
/// torrents' traffic in the range (as in `GeoStats`).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PeerBreakdown {
    /// The torrent, or `null` for all.
    #[schema(required = true)]
    pub hash: Option<String>,
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Broken down by.
    pub dim: PeerDimension,
    /// Values, highest first.
    pub rows: Vec<PeerRow>,
    /// Their buckets, oldest first (`series=true`).
    pub points: Vec<PeerPoint>,
    /// Traffic not tied to a peer (see `GeoStats`).
    pub unattributed: ByteTotals,
}

/// How torrents are grouped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum GroupKind {
    /// By category.
    Category,
    /// By tag (a torrent counts in each of its tags).
    Tag,
}

/// Query of traffic by category or tag.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct GroupQuery {
    /// Grouped by.
    pub group: GroupKind,
    /// Buckets starting at or after this time, unix seconds; default: one
    /// day before `to`.
    pub from: Option<u64>,
    /// Buckets starting at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// Bucket size; default: the finest kept for the whole range.
    pub step: Option<StatsStep>,
    /// Ranked by; default `uploaded`.
    pub by: Option<TopMetric>,
    /// At most this many groups (1 to 250); default 20.
    pub limit: Option<u32>,
    /// Also return each group's buckets (`points`); default false.
    pub series: Option<bool>,
}

/// A group's traffic over a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GroupRow {
    /// The category or tag; `null` = none.
    #[schema(required = true)]
    pub key: Option<String>,
    /// Payload bytes downloaded by its torrents.
    pub downloaded: u64,
    /// Payload bytes uploaded by its torrents.
    pub uploaded: u64,
    /// Its torrents that moved data.
    pub torrents: u32,
}

/// A group's traffic in one bucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct GroupPoint {
    /// Bucket start, unix seconds.
    pub t: u64,
    /// The category or tag; `null` = none.
    #[schema(required = true)]
    pub key: Option<String>,
    /// Payload bytes downloaded.
    pub downloaded: u64,
    /// Payload bytes uploaded.
    pub uploaded: u64,
}

/// Traffic by category or tag, by the membership each torrent has now (or
/// had when it was removed): changing a torrent's category moves its
/// history with it. With tags, a torrent counts in each of its tags.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GroupStats {
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Grouped by.
    pub group: GroupKind,
    /// Groups, highest first.
    pub rows: Vec<GroupRow>,
    /// Their buckets, oldest first (`series=true`).
    pub points: Vec<GroupPoint>,
}

/// Query of the per-tracker statistics.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TrackerQuery {
    /// Buckets starting at or after this time, unix seconds; default: one
    /// day before `to`.
    pub from: Option<u64>,
    /// Buckets starting at or before this time, unix seconds; default: now.
    pub to: Option<u64>,
    /// `hour` or `day`; default: the finest kept for the whole range.
    pub step: Option<StatsStep>,
    /// Ranked by; default `uploaded`.
    pub by: Option<TopMetric>,
    /// At most this many trackers (1 to 250); default 50.
    pub limit: Option<u32>,
}

/// A tracker (by host) over a range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct TrackerRow {
    /// The tracker's host; `null` = torrents with no working tracker
    /// (DHT only, or every tracker failing).
    #[schema(required = true)]
    pub host: Option<String>,
    /// Payload bytes downloaded by the torrents working with it.
    pub downloaded: u64,
    /// Payload bytes uploaded by the torrents working with it (what a
    /// private tracker credits, less what it does not see).
    pub uploaded: u64,
    /// Torrents working with it that moved data.
    pub torrents: u32,
    /// Announces it answered.
    pub announces: u64,
    /// Announces that failed.
    pub announce_errors: u64,
}

/// Per tracker: the traffic of the torrents that work with it (the one each
/// torrent last worked with), and how its announces went. Only hosts are
/// kept: private trackers' URLs carry passkeys.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrackerStats {
    /// The range, unix seconds.
    pub from: u64,
    /// The range, unix seconds.
    pub to: u64,
    /// The bucket size.
    pub step: StatsStep,
    /// Trackers, highest first.
    pub rows: Vec<TrackerRow>,
}

/// Query of the idle-seed report.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct IdleQuery {
    /// The window, in days back from today (1 to 365); default 30.
    pub days: Option<u32>,
    /// At most this many torrents (1 to 1000); default 50.
    pub limit: Option<u32>,
}

/// A complete torrent and what it uploaded in the window.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct IdleSeed {
    /// Info-hash.
    pub hash: String,
    /// Name.
    pub name: String,
    /// Bytes on disk (the wanted files).
    pub size: u64,
    /// Payload bytes uploaded in the window.
    pub uploaded: u64,
    /// `uploaded` / `size`: how many times over it was shared in the window.
    pub value: f64,
    /// Seconds it was seeding in the window.
    pub seeding_time: u64,
    /// When it last uploaded, unix seconds; `null` = never.
    #[schema(required = true)]
    pub last_upload: Option<u64>,
    /// All-time share ratio.
    #[schema(required = true)]
    pub ratio: Option<f64>,
    /// When it was added, unix seconds.
    pub added_on: u64,
    /// Its state.
    pub state: TorrentState,
    /// Its category.
    #[schema(required = true)]
    pub category: Option<String>,
    /// Host of the tracker it works with.
    #[schema(required = true)]
    pub tracker: Option<String>,
}

/// Complete torrents by what they uploaded in a window relative to their
/// size, least first: the candidates for removal come first.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct IdleSeeds {
    /// The window's start (00:00 UTC, `days` days back), unix seconds.
    pub from: u64,
    /// Recording covers the window from here (later than `from` when
    /// statistics started within the window); `null` = nothing recorded.
    #[schema(required = true)]
    pub recorded_from: Option<u64>,
    /// Least valuable first.
    pub torrents: Vec<IdleSeed>,
}

// ---- Metadata previews (`/previews`) ----

/// What to preview.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    /// A magnet link, an info-hash, or the http(s) URL of a `.torrent`.
    pub source: String,
    /// Cookie header for the URL.
    #[serde(default)]
    pub cookie: Option<String>,
}

/// Where a preview stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreviewState {
    /// Asking peers for the metadata.
    Fetching,
    /// The metadata is here (`metadata`).
    Ready,
    /// Fetching failed (`error`).
    Failed,
}

/// A torrent's metadata, fetched without adding the torrent (qBittorrent's
/// `fetchMetadata`). Adding the same info-hash (`POST /torrents`, as a
/// magnet link or info-hash) uses it, with no second fetch.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PreviewInfo {
    /// Info-hash.
    pub hash: String,
    /// The name (the magnet's `dn` until the metadata is here).
    pub name: String,
    /// Where it stands.
    pub state: PreviewState,
    /// When it was asked for, unix seconds.
    pub created: u64,
    /// When it is dropped unless read again, unix seconds.
    pub expires: u64,
    /// Peers connected while fetching; `null` otherwise.
    #[schema(required = true)]
    pub peers: Option<u32>,
    /// The metadata (`ready`).
    #[schema(required = true)]
    pub metadata: Option<TorrentMetadata>,
    /// Why fetching failed (`failed`).
    #[schema(required = true)]
    pub error: Option<String>,
}

// ---- Webhooks (`/webhooks`) ----

/// What a webhook is told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WebhookEvent {
    /// A torrent was added.
    Added,
    /// A magnet link's metadata arrived.
    Metadata,
    /// Every wanted piece is downloaded (a move to the save path may
    /// follow: `moved`).
    Finished,
    /// A torrent's content moved (`detail`: the new directory).
    Moved,
    /// A torrent stopped with an error (`detail`: the message).
    Error,
    /// A torrent was removed.
    Removed,
    /// `POST /webhooks/{id}/test`.
    Test,
}

/// A new webhook.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WebhookRequest {
    /// Where to POST the events (http or https).
    pub url: String,
    /// A label.
    #[serde(default)]
    pub name: Option<String>,
    /// The events it gets; empty (the default) = all.
    #[serde(default)]
    pub events: Vec<WebhookEvent>,
    /// Signs each delivery (`X-Urtorrentd-Signature`); never shown again.
    #[serde(default)]
    pub secret: Option<String>,
    /// On (the default) or off.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// A change to a webhook: only the fields present change.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WebhookPatch {
    /// Where to POST the events.
    #[serde(default)]
    pub url: Option<String>,
    /// A label; `null` removes it.
    #[serde(default, deserialize_with = "crate::util::patch_field")]
    #[schema(nullable = true)]
    pub name: Option<Option<String>>,
    /// The events it gets; empty = all.
    #[serde(default)]
    pub events: Option<Vec<WebhookEvent>>,
    /// The signing secret; `null` removes it.
    #[serde(default, deserialize_with = "crate::util::patch_field")]
    #[schema(nullable = true)]
    pub secret: Option<Option<String>>,
    /// On or off.
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// One delivery (with its retries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct WebhookDelivery {
    /// Its id (`X-Urtorrentd-Delivery`).
    pub id: String,
    /// When it was first tried, unix seconds.
    pub time: u64,
    /// The event.
    pub event: WebhookEvent,
    /// The torrent; `null` for `test`.
    #[schema(required = true)]
    pub hash: Option<String>,
    /// The last HTTP status; `null` = no answer.
    #[schema(required = true)]
    pub status: Option<u16>,
    /// What went wrong on the last try; `null` = delivered (2xx).
    #[schema(required = true)]
    pub error: Option<String>,
    /// Tries made (at most 4: at once, then after 2 s, 10 s and 60 s; only
    /// no answer, 429 and 5xx are retried).
    pub attempts: u32,
}

/// A webhook.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Webhook {
    /// Its id.
    pub id: u32,
    /// A label.
    #[schema(required = true)]
    pub name: Option<String>,
    /// Where the events go.
    pub url: String,
    /// The events it gets; empty = all.
    pub events: Vec<WebhookEvent>,
    /// On or off.
    pub enabled: bool,
    /// Deliveries are signed.
    pub has_secret: bool,
    /// Its last deliveries (since the start, at most 20), newest first.
    pub deliveries: Vec<WebhookDelivery>,
}

/// What a webhook receives: `POST` with this JSON body and the headers
/// `X-Urtorrentd-Event`, `X-Urtorrentd-Delivery`, `X-Urtorrentd-Timestamp`
/// and, with a secret, `X-Urtorrentd-Signature: sha256=<hex>`: the
/// HMAC-SHA256 of `<timestamp>.<body>` with the secret.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WebhookPayload {
    /// What happened.
    pub event: WebhookEvent,
    /// When, unix seconds.
    pub time: u64,
    /// This delivery's id (the same on every retry).
    pub delivery: String,
    /// The torrent's info-hash; `null` for `test`.
    #[schema(required = true)]
    pub hash: Option<String>,
    /// The torrent as the list shows it (for `removed`, just before);
    /// `null` for `test`, or if it could not be read.
    #[schema(required = true)]
    pub torrent: Option<TorrentSummary>,
    /// The new directory (`moved`) or the error (`error`).
    #[schema(required = true)]
    pub detail: Option<String>,
}

// ---- RSS (`/rss`) ----

/// An RSS or Atom feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct RssFeed {
    /// Its id.
    pub id: u32,
    /// The feed's URL.
    pub url: String,
    /// A label given to it; `null` = its own title.
    #[schema(required = true)]
    pub name: Option<String>,
    /// The title the feed gives itself.
    #[schema(required = true)]
    pub title: Option<String>,
    /// The folder it is in (`tv/anime`); `null` = the top.
    #[schema(required = true)]
    pub folder: Option<String>,
    /// Seconds between refreshes; `null` = the `rss_refresh_interval`
    /// setting.
    #[schema(required = true)]
    pub refresh_interval: Option<u64>,
    /// When it was last refreshed, unix seconds; `null` = never.
    #[schema(required = true)]
    pub last_refresh: Option<u64>,
    /// Why the last refresh failed; `null` = it did not.
    #[schema(required = true)]
    pub error: Option<String>,
    /// A refresh is running.
    pub loading: bool,
    /// Articles kept.
    pub articles: u32,
    /// Articles not read.
    pub unread: u32,
}

/// A feed and its articles.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RssFeedDetail {
    /// The feed.
    pub feed: RssFeed,
    /// Its articles, newest first.
    pub articles: Vec<RssArticle>,
}

/// A new feed.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssFeedRequest {
    /// The feed's URL (http or https).
    pub url: String,
    /// A label.
    #[serde(default)]
    pub name: Option<String>,
    /// The folder to put it in (created if missing).
    #[serde(default)]
    pub folder: Option<String>,
    /// Seconds between refreshes (at least 60); absent = the setting.
    #[serde(default)]
    pub refresh_interval: Option<u64>,
}

/// A change to a feed: only the fields present change.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssFeedPatch {
    /// The feed's URL.
    #[serde(default)]
    pub url: Option<String>,
    /// A label; `null` removes it.
    #[serde(default, deserialize_with = "crate::util::patch_field")]
    #[schema(nullable = true)]
    pub name: Option<Option<String>>,
    /// The folder; `null` = the top.
    #[serde(default, deserialize_with = "crate::util::patch_field")]
    #[schema(nullable = true)]
    pub folder: Option<Option<String>>,
    /// Seconds between refreshes; `null` = the setting.
    #[serde(default, deserialize_with = "crate::util::patch_field")]
    #[schema(nullable = true)]
    pub refresh_interval: Option<Option<u64>>,
}

/// An article of a feed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct RssArticle {
    /// Its id within the feed (the `guid`, else the link).
    pub id: String,
    /// The feed.
    pub feed: u32,
    /// Title.
    pub title: String,
    /// Published, unix seconds.
    #[schema(required = true)]
    pub date: Option<u64>,
    /// Link to the article.
    #[schema(required = true)]
    pub link: Option<String>,
    /// What would be added: a `.torrent` URL or a magnet link.
    #[schema(required = true)]
    pub torrent_url: Option<String>,
    /// Description (HTML as the feed gives it, at most 16 KiB).
    #[schema(required = true)]
    pub description: Option<String>,
    /// Author.
    #[schema(required = true)]
    pub author: Option<String>,
    /// Content size, bytes, when the feed says.
    #[schema(required = true)]
    pub size: Option<u64>,
    /// Marked read.
    pub read: bool,
    /// Added by a download rule.
    pub downloaded: bool,
}

/// Query of articles across feeds.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct RssArticlesQuery {
    /// One feed; default: all.
    pub feed: Option<u32>,
    /// Only articles not read.
    pub unread: Option<bool>,
    /// At most this many, the newest (1 to 5000); default 500.
    pub limit: Option<u32>,
}

/// Which articles of a feed: a list of ids or `"all"`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum RssArticleIds {
    /// Every article.
    All(AllTorrents),
    /// These ids.
    List(Vec<String>),
}

/// Articles to mark read.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssReadRequest {
    /// The articles.
    pub articles: RssArticleIds,
}

/// A folder path (`tv/anime`).
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssFolderRequest {
    /// The folder.
    pub path: String,
}

/// Move (rename) a folder, with what is in it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssFolderMove {
    /// The folder.
    pub from: String,
    /// Its new path.
    pub to: String,
}

/// An automatic download rule. See `docs/api.md` for how titles match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
pub struct RssRule {
    /// Its name.
    pub name: String,
    /// On.
    pub enabled: bool,
    /// What a title must contain (wildcards, or a regular expression).
    pub must_contain: String,
    /// What it must not contain.
    pub must_not_contain: String,
    /// `must_contain` and `must_not_contain` are regular expressions.
    pub use_regex: bool,
    /// Seasons and episodes to take (`1x2;1x8-15;2x1-;`); empty = any.
    pub episode_filter: String,
    /// Take each episode once (repacks and propers once more with
    /// `rss_download_repacks`).
    pub smart_filter: bool,
    /// The feeds it applies to (ids).
    pub feeds: Vec<u32>,
    /// After a match, take nothing for this many days; 0 = off.
    pub ignore_days: u32,
    /// How what it takes is added (as in `POST /torrents`).
    pub add_options: AddOptions,
    /// When it last took something, unix seconds.
    #[schema(required = true)]
    pub last_match: Option<u64>,
    /// Episodes it took (smart filter).
    pub matched_episodes: Vec<String>,
}

/// A rule's definition (`PUT /rss/rules/{name}`); its history is kept.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssRuleRequest {
    /// On (the default).
    #[serde(default)]
    pub enabled: Option<bool>,
    /// What a title must contain; empty = anything.
    #[serde(default)]
    pub must_contain: String,
    /// What it must not contain.
    #[serde(default)]
    pub must_not_contain: String,
    /// Regular expressions instead of wildcards.
    #[serde(default)]
    pub use_regex: bool,
    /// Seasons and episodes to take; empty = any.
    #[serde(default)]
    pub episode_filter: String,
    /// Take each episode once.
    #[serde(default)]
    pub smart_filter: bool,
    /// The feeds it applies to (ids).
    #[serde(default)]
    pub feeds: Vec<u32>,
    /// After a match, take nothing for this many days.
    #[serde(default)]
    pub ignore_days: u32,
    /// How what it takes is added.
    #[serde(default)]
    pub add_options: AddOptions,
    /// Forget the episodes it took and when it last matched.
    #[serde(default)]
    pub reset_history: bool,
}

/// A rule's new name.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RssRuleRename {
    /// The new name.
    pub name: String,
}

/// The `{name}` path parameter of a rule.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Path)]
pub struct RssRulePath {
    /// Rule name.
    pub name: String,
}

/// The `{id}` path parameter of a feed.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Path)]
pub struct RssFeedPath {
    /// Feed id.
    pub id: u32,
}

// ---- Client data (`/client-data`) ----

/// Query of the client data store.
#[derive(Debug, Clone, Default, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ClientDataQuery {
    /// Comma-separated keys; absent = every key.
    pub keys: Option<String>,
}

// ---- Cookies, fetched trackers, interfaces ----

/// A cookie sent with the daemon's own HTTP requests (`.torrent`
/// downloads, RSS feeds) to its domain (qBittorrent's `app/cookies`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Cookie {
    /// Name.
    pub name: String,
    /// Value.
    pub value: String,
    /// The domain (`tracker.example`: that host and its subdomains).
    pub domain: String,
    /// Only for paths under this one (default `/`).
    #[serde(default = "default_cookie_path")]
    pub path: String,
    /// When it expires, unix seconds; absent or `null` = never.
    #[serde(default)]
    pub expires: Option<u64>,
}

fn default_cookie_path() -> String {
    "/".to_string()
}

/// The trackers fetched from `add_trackers_url`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct FetchedTrackers {
    /// The URL they come from.
    pub url: String,
    /// The trackers (added to new public torrents).
    pub trackers: Vec<String>,
    /// When they were fetched, unix seconds; `null` = not yet.
    #[schema(required = true)]
    pub fetched: Option<u64>,
    /// Why the last fetch failed; `null` = it did not.
    #[schema(required = true)]
    pub error: Option<String>,
}

/// A network interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct NetworkInterface {
    /// Its name (for `listen_interface`).
    pub name: String,
    /// Its addresses.
    pub addresses: Vec<String>,
    /// It is up.
    pub up: bool,
}

/// Move incomplete torrents' content to a download path (or back).
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DownloadPathRequest {
    /// The torrents.
    pub hashes: Hashes,
    /// The download path (absolute); `null` = none (the content goes to
    /// the save path).
    #[serde(default)]
    pub path: Option<String>,
}
