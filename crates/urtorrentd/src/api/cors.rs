// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! CORS for the browser origins in `api_cors_origins` (ADR 0008). The
//! outermost layer: preflights are answered before the other guards, and
//! every response to a listed origin, errors included, carries the
//! `Access-Control-Allow-*` headers so its page can read it. Origins not
//! listed get no CORS headers, so browsers keep hiding the responses from
//! their pages. The web UI the daemon serves is same-origin and needs none.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::daemon::Daemon;
use crate::error::{ApiError, ErrorCode};

/// The methods the API uses.
const METHODS: HeaderValue = HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE");
/// The request headers a page may send: JSON bodies, an API key, and
/// `EventSource`'s resume header.
const HEADERS: HeaderValue = HeaderValue::from_static("content-type, authorization, last-event-id");
/// How long a browser may cache a preflight answer (seconds).
const MAX_AGE: HeaderValue = HeaderValue::from_static("600");

/// The request's `Origin`, when it is one of `allowed` (compared without
/// regard to case, as a whole).
pub(crate) fn listed_origin<'a>(
    headers: &'a HeaderMap,
    allowed: &[String],
) -> Option<&'a HeaderValue> {
    let origin = headers.get(header::ORIGIN)?;
    let text = origin.to_str().ok()?;
    allowed
        .iter()
        .any(|a| a.eq_ignore_ascii_case(text))
        .then_some(origin)
}

fn allow(headers: &mut HeaderMap, origin: HeaderValue) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
}

/// The CORS layer.
pub(crate) async fn cors(State(d): State<Arc<Daemon>>, req: Request, next: Next) -> Response {
    let allowed = {
        let st = d.state();
        if st.settings.api_cors_origins.is_empty() {
            None
        } else {
            Some(st.settings.api_cors_origins.clone())
        }
    };
    let Some(allowed) = allowed else {
        return next.run(req).await;
    };
    let origin = listed_origin(req.headers(), &allowed).cloned();
    let preflight = req.method() == Method::OPTIONS
        && req.headers().contains_key(header::ORIGIN)
        && req
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);
    let mut response = if preflight {
        match origin.clone() {
            Some(_) => {
                let mut r = StatusCode::NO_CONTENT.into_response();
                let h = r.headers_mut();
                h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, METHODS);
                h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HEADERS);
                h.insert(header::ACCESS_CONTROL_MAX_AGE, MAX_AGE);
                r
            }
            None => ApiError::new(
                StatusCode::FORBIDDEN,
                ErrorCode::CrossOrigin,
                "this origin is not in api_cors_origins",
            )
            .into_response(),
        }
    } else {
        next.run(req).await
    };
    let h = response.headers_mut();
    h.append(header::VARY, HeaderValue::from_static("origin"));
    if let Some(origin) = origin {
        allow(h, origin);
    }
    response
}
