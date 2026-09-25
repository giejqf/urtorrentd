// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The web UI's files (ADR 0008, `frontend/AGENTS.md` section 5), served at
//! `/` next to the API at `/api/v1`: built into the binary (cargo feature
//! `web-ui`) or read from a directory (`--web-ui <dir>`). The files are
//! public (they hold no secrets; the data behind them needs a session), and
//! every path outside `/api/` without a file of its own is a route of the
//! single-page app, answered with `index.html`.

use std::borrow::Cow;
use std::io;
use std::path::{Path, PathBuf};

use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::error::{ApiError, ErrorCode};
use crate::util::blocking;

#[cfg(feature = "web-ui")]
mod embedded {
    include!(concat!(env!("OUT_DIR"), "/web_ui.rs"));
}

/// The policy for the UI's pages: its own scripts only, styles from its own
/// files (and the inline styles components set), data only from the daemon,
/// and never inside a frame (qBittorrent's clickjacking protection).
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                   img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; \
                   base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/// Where the web UI's files come from.
#[derive(Debug, Clone)]
pub enum WebUi {
    /// Built into the binary (`--features web-ui`).
    #[cfg(feature = "web-ui")]
    Embedded,
    /// A directory holding a build (canonical path).
    Dir(PathBuf),
}

impl WebUi {
    /// The UI built into the binary, when it has one.
    pub fn embedded() -> Option<WebUi> {
        #[cfg(feature = "web-ui")]
        {
            Some(WebUi::Embedded)
        }
        #[cfg(not(feature = "web-ui"))]
        {
            None
        }
    }

    /// A directory with a build of the UI; it must hold `index.html`.
    pub fn dir(path: &Path) -> io::Result<WebUi> {
        let root = path.canonicalize().map_err(|e| {
            io::Error::new(
                e.kind(),
                format!("web UI directory {}: {e}", path.display()),
            )
        })?;
        if !root.join("index.html").is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("web UI directory {} has no index.html", root.display()),
            ));
        }
        Ok(WebUi::Dir(root))
    }

    /// Where the files come from, for the log.
    pub fn describe(&self) -> String {
        match self {
            #[cfg(feature = "web-ui")]
            WebUi::Embedded => "built in".to_string(),
            WebUi::Dir(root) => format!("from {}", root.display()),
        }
    }

    /// A file of the build by its relative path (`assets/x.js`).
    async fn file(&self, rel: &str) -> Option<Cow<'static, [u8]>> {
        match self {
            #[cfg(feature = "web-ui")]
            WebUi::Embedded => embedded::FILES
                .iter()
                .find(|(p, _)| *p == rel)
                .map(|(_, bytes)| Cow::Borrowed(*bytes)),
            WebUi::Dir(root) => {
                let root = root.clone();
                let path = root.join(rel);
                blocking(move || {
                    // Symbolic links may point anywhere: only files that
                    // really are inside the directory are served.
                    let real = path.canonicalize()?;
                    if !real.starts_with(&root) || !real.is_file() {
                        return Err(io::ErrorKind::NotFound.into());
                    }
                    std::fs::read(real)
                })
                .await
                .ok()
                .map(Cow::Owned)
            }
        }
    }
}

/// Whether a request path belongs to the API (never to the UI).
pub(crate) fn is_api_path(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// The build-relative file a request path names; `None` when a segment
/// could leave the build or names a hidden file. The path is taken as it
/// arrives (percent-escapes are not decoded: the build's names need none).
fn relative(path: &str) -> Option<String> {
    let mut parts = Vec::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if seg.starts_with('.') || seg.contains(['\\', '\0']) {
            return None;
        }
        parts.push(seg);
    }
    Some(parts.join("/"))
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response {
    ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, "no such file").into_response()
}

fn file_response(rel: &str, bytes: Cow<'static, [u8]>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(rel)),
    );
    // Vite names what is under assets/ by content hash: they never change.
    let cache = if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

/// Answer a request outside the API: a file of the build, or `index.html`
/// for a route of the single-page app (a path whose last segment has no
/// extension). A missing file with an extension is a 404, so a stale asset
/// never turns into a page.
pub(crate) async fn serve(ui: &WebUi, method: &Method, uri: &Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return not_found();
    }
    let Some(rel) = relative(uri.path()) else {
        return not_found();
    };
    if !rel.is_empty()
        && let Some(bytes) = ui.file(&rel).await
    {
        return file_response(&rel, bytes);
    }
    if rel
        .rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
    {
        return not_found();
    }
    match ui.file("index.html").await {
        Some(bytes) => file_response("index.html", bytes),
        None => not_found(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(relative("/").as_deref(), Some(""));
        assert_eq!(relative("/assets/a.js").as_deref(), Some("assets/a.js"));
        assert_eq!(relative("//assets//a.js").as_deref(), Some("assets/a.js"));
        assert_eq!(relative("/torrents/abc").as_deref(), Some("torrents/abc"));
        assert_eq!(relative("/../etc/passwd"), None);
        assert_eq!(relative("/assets/../../x"), None);
        assert_eq!(relative("/.env"), None);
        assert_eq!(relative("/a\\b"), None);
        assert!(is_api_path("/api"));
        assert!(is_api_path("/api/v1/app"));
        assert!(!is_api_path("/apiary"));
        assert!(!is_api_path("/"));
    }

    #[test]
    fn types() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/x-1.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("assets/geist.woff2"), "font/woff2");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
    }
}
