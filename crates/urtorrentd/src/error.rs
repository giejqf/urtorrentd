// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The one error type of the API (AGENTS.md 4.3): an HTTP status plus a JSON
//! body with a stable machine-readable code.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use utoipa::ToSchema;

/// Machine-readable error codes. Clients branch on these, never on messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request is malformed or a value is out of range.
    BadRequest,
    /// Authentication is missing or wrong.
    Unauthorized,
    /// The client address is banned after too many failed logins.
    Banned,
    /// A cross-origin browser request was refused.
    CrossOrigin,
    /// The `Host` header names a host that is not allowed.
    HostNotAllowed,
    /// No such endpoint or resource.
    NotFound,
    /// No torrent with that info-hash.
    TorrentNotFound,
    /// The torrent is already in the session.
    Duplicate,
    /// The request conflicts with the current state.
    Conflict,
    /// The torrent is busy with an operation that cannot overlap this one.
    Busy,
    /// Not a valid `.torrent`, magnet link or info-hash.
    InvalidTorrent,
    /// Fetching a `.torrent` from a URL, or a GeoIP database, failed.
    DownloadFailed,
    /// The daemon is shutting down.
    ShuttingDown,
    /// A part of the daemon is not available (the statistics database could
    /// not be opened); see the message.
    Unavailable,
    /// A disk or network operation failed.
    Io,
    /// Something unexpected; see the message.
    Internal,
}

/// The error object.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ErrorDetail {
    /// Stable code.
    pub code: ErrorCode,
    /// Human-readable explanation.
    pub message: String,
}

/// Every error response has this body.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ErrorBody {
    /// The error.
    pub error: ErrorDetail,
}

/// An API error.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    /// HTTP status.
    pub status: StatusCode,
    /// Stable code.
    pub code: ErrorCode,
    /// Human-readable explanation.
    pub message: String,
}

/// Result alias for handlers and daemon operations.
pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    /// Build an error.
    pub fn new(status: StatusCode, code: ErrorCode, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            code,
            message: message.into(),
        }
    }

    /// 400 `bad_request`.
    pub fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, ErrorCode::BadRequest, message)
    }

    /// 404 `torrent_not_found`.
    pub fn torrent_not_found(hash: &str) -> ApiError {
        ApiError::new(
            StatusCode::NOT_FOUND,
            ErrorCode::TorrentNotFound,
            format!("no torrent with info-hash {hash}"),
        )
    }

    /// 404 `not_found`.
    pub fn not_found(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, message)
    }

    /// 409 `conflict`.
    pub fn conflict(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::CONFLICT, ErrorCode::Conflict, message)
    }

    /// 500 `io`.
    pub fn io(e: impl std::fmt::Display) -> ApiError {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Io,
            e.to_string(),
        )
    }

    /// 503 `unavailable`.
    pub fn unavailable(message: impl Into<String>) -> ApiError {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::Unavailable,
            message,
        )
    }

    /// 500 `internal`.
    pub fn internal(message: impl Into<String>) -> ApiError {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Internal,
            message,
        )
    }

    /// The JSON body.
    pub fn detail(&self) -> ErrorDetail {
        ErrorDetail {
            code: self.code,
            message: self.message.clone(),
        }
    }
}

impl From<urtorrent::Error> for ApiError {
    fn from(e: urtorrent::Error) -> ApiError {
        use urtorrent::Error as E;
        let (status, code) = match &e {
            E::NoSuchTorrent => (StatusCode::NOT_FOUND, ErrorCode::TorrentNotFound),
            E::Duplicate => (StatusCode::CONFLICT, ErrorCode::Duplicate),
            E::Metainfo(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidTorrent),
            E::InvalidArgument(_) | E::Unsupported(_) => {
                (StatusCode::BAD_REQUEST, ErrorCode::BadRequest)
            }
            E::Busy(_) => (StatusCode::CONFLICT, ErrorCode::Busy),
            E::Shutdown => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::ShuttingDown),
            E::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Io),
            E::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Internal),
        };
        ApiError::new(status, code, e.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> ApiError {
        ApiError::io(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error: self.detail(),
        };
        (self.status, axum::Json(body)).into_response()
    }
}
