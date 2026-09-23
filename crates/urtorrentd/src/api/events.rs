// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/events`: the sync diffs pushed as server-sent events.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;

use super::Query;
use crate::daemon::Daemon;
use crate::model::{EventsQuery, SyncResponse};

/// How often an idle stream sends a comment line, so proxies and clients
/// see it alive.
const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// Live updates as server-sent events (`text/event-stream`). Every event is
/// named `sync`, its `id` is the revision and its `data` a `SyncResponse`:
/// the first is everything (or the changes since `rev`), the next ones only
/// what changed, at most once a second and only when something did. On
/// reconnect a browser's `EventSource` sends the last id as `Last-Event-ID`,
/// which resumes from there. Idle streams get a comment every 15 s.
#[utoipa::path(
    get, path = "/events", tag = "sync",
    params(
        EventsQuery,
        ("Last-Event-ID" = Option<String>, Header, description = "The last event id received (sent by `EventSource` on reconnect); wins over `rev`."),
    ),
    responses((
        status = 200,
        description = "A stream of `sync` events; each `data` is a `SyncResponse`.",
        content_type = "text/event-stream",
        body = SyncResponse,
    ))
)]
pub(crate) async fn stream_events(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<EventsQuery>,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let resume = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or(q.rev);
    Sse::new(crate::sync::event_stream(d, resume)).keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
}
