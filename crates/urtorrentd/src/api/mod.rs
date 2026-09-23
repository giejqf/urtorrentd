// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The HTTP API under `/api/v1` (AGENTS.md 4.3). Every route is registered
//! through `utoipa-axum` from its `#[utoipa::path]` annotation, so the
//! OpenAPI document ([`openapi`]) and the router ([`router`]) come from the
//! same list and cannot drift apart.

mod app;
mod auth;
mod categories;
mod guard;
mod logs;
mod sync;
mod torrent;
mod torrents;
mod transfer;

use std::sync::Arc;

use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, FromRequest, FromRequestParts};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::openapi::security::{ApiKey, ApiKeyValue, HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::openapi::{OpenApi as OpenApiDoc, RefOr, ResponseBuilder};
use utoipa::{Modify, OpenApi};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

use crate::daemon::Daemon;
use crate::error::{ApiError, ErrorBody, ErrorCode};
use crate::model::{DirectoryMode, TorrentFilter, TorrentSort};

/// The API base path.
pub const BASE: &str = "/api/v1";
/// The session cookie.
pub const SESSION_COOKIE: &str = "urtorrentd_sid";
/// Largest request body (base64 `.torrent` files can be large).
const BODY_LIMIT: usize = 96 * 1024 * 1024;

type AppState = Arc<Daemon>;

/// A JSON body or response. Malformed bodies become `bad_request` errors in
/// the API's error shape.
#[derive(Debug, Clone, Copy, Default, FromRequest)]
#[from_request(via(axum::Json), rejection(ApiError))]
pub struct Json<T>(pub T);

impl<T: Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        axum::Json(self.0).into_response()
    }
}

impl From<JsonRejection> for ApiError {
    fn from(r: JsonRejection) -> ApiError {
        ApiError::bad_request(r.body_text())
    }
}

/// Query parameters, with rejections in the API's error shape.
#[derive(Debug, Clone, Copy, Default, FromRequestParts)]
#[from_request(via(axum::extract::Query), rejection(ApiError))]
pub struct Query<T>(pub T);

impl From<QueryRejection> for ApiError {
    fn from(r: QueryRejection) -> ApiError {
        ApiError::bad_request(r.body_text())
    }
}

/// Path parameters, with rejections in the API's error shape.
#[derive(Debug, Clone, Copy, Default, FromRequestParts)]
#[from_request(via(axum::extract::Path), rejection(ApiError))]
pub struct Path<T>(pub T);

impl From<PathRejection> for ApiError {
    fn from(r: PathRejection) -> ApiError {
        ApiError::bad_request(r.body_text())
    }
}

/// The `{hash}` path parameter.
#[derive(Debug, Clone, serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Path)]
pub struct HashPath {
    /// Info-hash, 40 hex characters.
    pub hash: String,
}

struct Security;

impl Modify for Security {
    fn modify(&self, doc: &mut OpenApiDoc) {
        let components = doc.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "session",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                SESSION_COOKIE,
                "Set by POST /api/v1/auth/login.",
            ))),
        );
        components.add_security_scheme(
            "api_key",
            SecurityScheme::Http(
                HttpBuilder::new()
                    .scheme(HttpAuthScheme::Bearer)
                    .description(Some("An API key from POST /api/v1/auth/api-key."))
                    .build(),
            ),
        );
    }
}

/// Every operation documents the error responses it can produce, all with
/// the one error body.
struct ErrorResponses;

impl Modify for ErrorResponses {
    fn modify(&self, doc: &mut OpenApiDoc) {
        let errors = [
            ("400", "Malformed request or invalid value."),
            ("401", "Not authenticated."),
            (
                "403",
                "Refused: banned address, foreign origin or host not allowed.",
            ),
            ("404", "No such torrent or resource."),
            ("409", "Conflicts with the current state."),
            ("500", "Disk or internal failure."),
            ("503", "Shutting down."),
        ];
        for item in doc.paths.paths.values_mut() {
            for op in [
                &mut item.get,
                &mut item.put,
                &mut item.post,
                &mut item.delete,
                &mut item.patch,
            ]
            .into_iter()
            .flatten()
            {
                for (code, text) in errors {
                    op.responses
                        .responses
                        .entry(code.to_string())
                        .or_insert_with(|| {
                            RefOr::T(
                                ResponseBuilder::new()
                                    .description(text)
                                    .content(
                                        "application/json",
                                        utoipa::openapi::ContentBuilder::new()
                                            .schema(Some(RefOr::Ref(
                                                utoipa::openapi::Ref::from_schema_name("ErrorBody"),
                                            )))
                                            .build(),
                                    )
                                    .build(),
                            )
                        });
                }
            }
        }
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "urtorrentd",
        description = "HTTP API of urtorrentd, a BitTorrent daemon on the urtorrent library. \
Units: bytes, bytes per second, seconds, unix seconds; `null` means unknown or unlimited. \
Errors always have the `ErrorBody` shape with a stable `code`."
    ),
    modifiers(&Security),
    security(("session" = []), ("api_key" = [])),
    // Schemas only referenced from query parameters are not collected
    // automatically; `every_ref_resolves` in tests/openapi.rs guards this.
    components(schemas(ErrorBody, ErrorCode, TorrentFilter, TorrentSort, DirectoryMode)),
    tags(
        (name = "auth", description = "Login sessions and API keys."),
        (name = "app", description = "The daemon: information, settings, shutdown, file system."),
        (name = "torrents", description = "The torrent list, adding torrents and bulk actions."),
        (name = "torrent", description = "One torrent: detail, files, trackers, web seeds, peers, pieces."),
        (name = "categories", description = "Categories and tags."),
        (name = "transfer", description = "Session-wide transfer state, speed limits and bans."),
        (name = "sync", description = "Incremental updates for polling clients."),
        (name = "log", description = "The main log and the peer log."),
    )
)]
struct ApiDoc;

/// Public routes (no authentication) and protected ones.
fn routes() -> (OpenApiRouter<AppState>, OpenApiRouter<AppState>) {
    let public = OpenApiRouter::new().routes(routes!(auth::login));
    let protected = OpenApiRouter::new()
        .routes(routes!(auth::logout))
        .routes(routes!(auth::set_credentials))
        .routes(routes!(auth::rotate_api_key, auth::delete_api_key))
        .routes(routes!(app::get_app_info))
        .routes(routes!(app::shutdown))
        .routes(routes!(app::get_settings, app::patch_settings))
        .routes(routes!(app::list_directory))
        .routes(routes!(torrents::list_torrents, torrents::add_torrents))
        .routes(routes!(torrents::count_torrents))
        .routes(routes!(torrents::parse_torrent))
        .routes(routes!(torrents::start_torrents))
        .routes(routes!(torrents::stop_torrents))
        .routes(routes!(torrents::force_start_torrents))
        .routes(routes!(torrents::recheck_torrents))
        .routes(routes!(torrents::reannounce_torrents))
        .routes(routes!(torrents::delete_torrents))
        .routes(routes!(torrents::move_torrents_in_queue))
        .routes(routes!(torrents::set_sequential))
        .routes(routes!(torrents::set_torrent_limits))
        .routes(routes!(torrents::set_share_limits))
        .routes(routes!(torrents::set_location))
        .routes(routes!(torrents::set_torrent_category))
        .routes(routes!(torrents::change_torrent_tags))
        .routes(routes!(torrents::set_auto_management))
        .routes(routes!(torrents::add_peers))
        .routes(routes!(torrent::get_torrent, torrent::patch_torrent))
        .routes(routes!(torrent::list_files))
        .routes(routes!(torrent::set_file_priority))
        .routes(routes!(torrent::rename_file))
        .routes(routes!(torrent::rename_folder))
        .routes(routes!(torrent::list_trackers, torrent::add_trackers))
        .routes(routes!(torrent::remove_trackers))
        .routes(routes!(torrent::edit_tracker))
        .routes(routes!(torrent::list_web_seeds, torrent::add_web_seeds))
        .routes(routes!(torrent::remove_web_seeds))
        .routes(routes!(torrent::edit_web_seed))
        .routes(routes!(torrent::list_peers))
        .routes(routes!(torrent::get_pieces))
        .routes(routes!(torrent::get_piece_hashes))
        .routes(routes!(torrent::export_torrent_file))
        .routes(routes!(
            categories::list_categories,
            categories::create_category,
            categories::edit_category
        ))
        .routes(routes!(categories::remove_categories))
        .routes(routes!(categories::list_tags, categories::create_tags))
        .routes(routes!(categories::delete_tags))
        .routes(routes!(transfer::get_transfer_info))
        .routes(routes!(transfer::set_alt_speed))
        .routes(routes!(transfer::ban_peers))
        .routes(routes!(sync::sync))
        .routes(routes!(logs::get_main_log))
        .routes(routes!(logs::get_peer_log));
    (public, protected)
}

fn assemble(
    public: OpenApiRouter<AppState>,
    protected: OpenApiRouter<AppState>,
) -> (axum::Router<AppState>, OpenApiDoc) {
    let (router, mut doc) = OpenApiRouter::with_openapi(ApiDoc::openapi())
        .nest(BASE, public.merge(protected))
        .split_for_parts();
    ErrorResponses.modify(&mut doc);
    (router, doc)
}

/// The OpenAPI document of the API.
pub fn openapi() -> OpenApiDoc {
    let (public, protected) = routes();
    assemble(public, protected).1
}

/// The OpenAPI document as pretty-printed JSON (what `openapi.json` holds).
pub fn openapi_json() -> String {
    let mut s = openapi().to_pretty_json().unwrap_or_default();
    s.push('\n');
    s
}

/// The complete router: routes, authentication, host checks, body limit, and
/// `GET /api/v1/openapi.json` (public).
pub fn router(daemon: Arc<Daemon>) -> axum::Router {
    let (public, protected) = routes();
    let protected = protected.route_layer(axum::middleware::from_fn_with_state(
        daemon.clone(),
        guard::authenticate,
    ));
    let (router, _) = assemble(public, protected);
    let doc = Arc::new(openapi_json());
    router
        .route(
            &format!("{BASE}/openapi.json"),
            axum::routing::get(move || {
                let doc = doc.clone();
                async move {
                    (
                        [(axum::http::header::CONTENT_TYPE, "application/json")],
                        doc.as_str().to_owned(),
                    )
                }
            }),
        )
        .fallback(|| async {
            ApiError::new(
                StatusCode::NOT_FOUND,
                ErrorCode::NotFound,
                "no such endpoint",
            )
        })
        .layer(axum::middleware::from_fn_with_state(
            daemon.clone(),
            guard::gate,
        ))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(daemon)
}

/// `204 No Content`.
pub(crate) fn no_content() -> StatusCode {
    StatusCode::NO_CONTENT
}
