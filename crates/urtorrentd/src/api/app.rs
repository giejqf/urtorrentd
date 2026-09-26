// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/app` and `/settings`: daemon information, shutdown, settings, the file
//! system browser.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{Json, Query};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{
    AppInfo, Cookie, DirectoryEntry, DirectoryMode, DirectoryQuery, NetworkInterface, WatchStatus,
};
use crate::settings::{Settings, SettingsPatch};
use crate::util::blocking;

/// About the daemon.
#[utoipa::path(get, path = "/app", tag = "app", responses((status = 200, body = AppInfo)))]
pub(crate) async fn get_app_info(State(d): State<Arc<Daemon>>) -> Json<AppInfo> {
    let settings = d.settings();
    Json(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: "v1".to_string(),
        library: urtorrent::Profile::native().user_agent.to_string(),
        pid: std::process::id(),
        started_at: d.started_at,
        data_dir: d.store.root().to_string_lossy().into_owned(),
        default_save_path: settings.save_path.clone(),
        listen_port: d.session.listen_port(),
        restart_required: settings.pending_restart(&d.running),
        geoip: d.geo.info(),
        instance_name: settings.instance_name.clone(),
        listen_addresses: {
            let (v4, v6) = d.listening();
            [v4.map(|a| a.to_string()), v6.map(|a| a.to_string())]
                .into_iter()
                .flatten()
                .collect()
        },
        fetched_trackers: d.fetched_trackers_info(),
        time_zone: jiff::tz::TimeZone::system().iana_name().map(str::to_string),
    })
}

/// Restart the daemon: shut it down gracefully (trackers are told, state is
/// saved), then the process starts again with the same arguments, so
/// settings that apply after a restart (`restart_required`) take effect.
/// The API is away for the few seconds that takes.
#[utoipa::path(post, path = "/app/restart", tag = "app", responses((status = 202, description = "Restarting.")))]
pub(crate) async fn restart(State(d): State<Arc<Daemon>>) -> StatusCode {
    d.logs.info("restart requested through the API");
    d.request_restart();
    StatusCode::ACCEPTED
}

/// Fetch the tracker list of `add_trackers_url` now instead of at its next
/// turn (once a day). `GET /app` shows the fetch under way
/// (`fetched_trackers.fetching`), then its result. 409 when
/// `add_trackers_url` is not set.
#[utoipa::path(
    post,
    path = "/app/fetched-trackers/refresh",
    tag = "app",
    responses((status = 202, description = "Fetching (or a fetch was under way)."))
)]
pub(crate) async fn refresh_fetched_trackers(
    State(d): State<Arc<Daemon>>,
) -> ApiResult<StatusCode> {
    d.refresh_tracker_list()?;
    Ok(StatusCode::ACCEPTED)
}

/// The watch folders (`watch_folders`): when each was last read, why one
/// cannot be, and the last files they took with what became of them. They
/// are read every 2 seconds; a file is taken once it has not changed for 3.
#[utoipa::path(get, path = "/watch-folders", tag = "app", responses((status = 200, body = WatchStatus)))]
pub(crate) async fn get_watch_folders(State(d): State<Arc<Daemon>>) -> Json<WatchStatus> {
    Json(d.watch_status())
}

/// Shut the daemon down gracefully (trackers are told, state is saved).
#[utoipa::path(post, path = "/app/shutdown", tag = "app", responses((status = 202, description = "Shutting down.")))]
pub(crate) async fn shutdown(State(d): State<Arc<Daemon>>) -> StatusCode {
    d.logs.info("shutdown requested through the API");
    d.request_shutdown();
    StatusCode::ACCEPTED
}

/// The settings.
#[utoipa::path(get, path = "/settings", tag = "app", responses((status = 200, body = Settings)))]
pub(crate) async fn get_settings(State(d): State<Arc<Daemon>>) -> Json<Settings> {
    Json(d.settings())
}

/// Change settings. Only the fields present change; the result is the
/// complete settings. Live fields apply at once; the engine-tuning ones after
/// a restart (see `GET /app`, `restart_required`).
#[utoipa::path(patch, path = "/settings", tag = "app", responses((status = 200, body = Settings)))]
pub(crate) async fn patch_settings(
    State(d): State<Arc<Daemon>>,
    Json(patch): Json<SettingsPatch>,
) -> ApiResult<Json<Settings>> {
    Ok(Json(d.update_settings(patch).await?))
}

/// List a directory on the daemon's machine (for choosing save paths).
#[utoipa::path(get, path = "/fs/directory", tag = "app", params(DirectoryQuery), responses((status = 200, body = Vec<DirectoryEntry>)))]
pub(crate) async fn list_directory(
    State(_d): State<Arc<Daemon>>,
    Query(q): Query<DirectoryQuery>,
) -> ApiResult<Json<Vec<DirectoryEntry>>> {
    let path = std::path::PathBuf::from(&q.path);
    if !path.is_absolute() || q.path.contains('\0') {
        return Err(ApiError::bad_request("path must be absolute"));
    }
    let mode = q.mode.unwrap_or_default();
    let entries = blocking(move || {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&path)? {
            let entry = entry?;
            let is_dir =
                entry.file_type().map(|t| t.is_dir()).unwrap_or(false) || entry.path().is_dir();
            let keep = match mode {
                DirectoryMode::All => true,
                DirectoryMode::Dirs => is_dir,
                DirectoryMode::Files => !is_dir,
            };
            if keep {
                out.push(DirectoryEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: entry.path().to_string_lossy().into_owned(),
                    is_dir,
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    })
    .await
    .map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::not_found(format!("no directory {}", q.path)),
        _ => ApiError::io(e),
    })?;
    Ok(Json(entries))
}

/// The cookie jar: cookies sent with the daemon's own HTTP requests
/// (`.torrent` downloads, RSS feeds, the tracker list) to their domain.
#[utoipa::path(get, path = "/app/cookies", tag = "app", responses((status = 200, body = Vec<Cookie>)))]
pub(crate) async fn get_cookies(State(d): State<Arc<Daemon>>) -> Json<Vec<Cookie>> {
    Json(d.cookies())
}

/// Replace the cookie jar (at most 1000 cookies).
#[utoipa::path(put, path = "/app/cookies", tag = "app", request_body = Vec<Cookie>, responses((status = 204, description = "Stored.")))]
pub(crate) async fn set_cookies(
    State(d): State<Arc<Daemon>>,
    Json(cookies): Json<Vec<Cookie>>,
) -> ApiResult<StatusCode> {
    d.set_cookies(cookies).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The network interfaces with their addresses (for `listen_interface`).
#[utoipa::path(get, path = "/app/interfaces", tag = "app", responses((status = 200, body = Vec<NetworkInterface>)))]
pub(crate) async fn list_interfaces() -> ApiResult<Json<Vec<NetworkInterface>>> {
    Ok(Json(blocking(crate::interfaces::list).await?))
}
