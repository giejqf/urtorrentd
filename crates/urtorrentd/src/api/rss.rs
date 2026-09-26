// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/rss`: feeds in folders, their articles, and automatic download rules
//! (qBittorrent's `rss/*`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{Json, Path, Query, no_content};
use crate::daemon::Daemon;
use crate::error::{ApiResult, ErrorBody};
use crate::model::{
    RssArticle, RssArticlesQuery, RssDryRunArticle, RssFeed, RssFeedDetail, RssFeedPatch,
    RssFeedPath, RssFeedProbe, RssFeedProbeRequest, RssFeedRequest, RssFeedsRequest, RssFolderMove,
    RssFolderRequest, RssReadRequest, RssRule, RssRulePath, RssRuleRename, RssRuleRequest,
};

/// Every feed.
#[utoipa::path(get, path = "/rss/feeds", tag = "rss", responses((status = 200, body = Vec<RssFeed>)))]
pub(crate) async fn list_rss_feeds(State(d): State<Arc<Daemon>>) -> ApiResult<Json<Vec<RssFeed>>> {
    Ok(Json(d.rss_feeds().await?))
}

/// Add a feed (refreshed at once).
#[utoipa::path(post, path = "/rss/feeds", tag = "rss", request_body = RssFeedRequest, responses((status = 201, body = RssFeed)))]
pub(crate) async fn add_rss_feed(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFeedRequest>,
) -> ApiResult<(StatusCode, Json<RssFeed>)> {
    Ok((StatusCode::CREATED, Json(d.add_rss_feed(req).await?)))
}

/// Look at a feed before adding it: its URL is fetched and read (with the
/// cookie jar and the identity's user agent, as refreshes are) and nothing
/// is kept.
#[utoipa::path(post, path = "/rss/feeds/probe", tag = "rss", request_body = RssFeedProbeRequest, responses((status = 200, body = RssFeedProbe), (status = 502, description = "The feed could not be fetched or read.", body = ErrorBody)))]
pub(crate) async fn probe_rss_feed(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFeedProbeRequest>,
) -> ApiResult<Json<RssFeedProbe>> {
    Ok(Json(d.probe_rss_feed(&req.url).await?))
}

/// A feed and its articles, newest first.
#[utoipa::path(get, path = "/rss/feeds/{id}", tag = "rss", params(RssFeedPath), responses((status = 200, body = RssFeedDetail)))]
pub(crate) async fn get_rss_feed(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssFeedPath>,
) -> ApiResult<Json<RssFeedDetail>> {
    Ok(Json(d.rss_feed(p.id).await?))
}

/// Change a feed: its URL, label, folder or refresh interval.
#[utoipa::path(patch, path = "/rss/feeds/{id}", tag = "rss", params(RssFeedPath), request_body = RssFeedPatch, responses((status = 200, body = RssFeed)))]
pub(crate) async fn patch_rss_feed(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssFeedPath>,
    Json(patch): Json<RssFeedPatch>,
) -> ApiResult<Json<RssFeed>> {
    Ok(Json(d.patch_rss_feed(p.id, patch).await?))
}

/// Remove a feed and its articles.
#[utoipa::path(delete, path = "/rss/feeds/{id}", tag = "rss", params(RssFeedPath), responses((status = 204, description = "Removed.")))]
pub(crate) async fn delete_rss_feed(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssFeedPath>,
) -> ApiResult<StatusCode> {
    d.delete_rss_feed(p.id).await?;
    Ok(no_content())
}

/// Refresh a feed now (also with `rss_enabled` off).
#[utoipa::path(post, path = "/rss/feeds/{id}/refresh", tag = "rss", params(RssFeedPath), responses((status = 202, description = "Refreshing.")))]
pub(crate) async fn refresh_rss_feed(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssFeedPath>,
) -> ApiResult<StatusCode> {
    d.refresh_rss_feed(p.id).await?;
    Ok(StatusCode::ACCEPTED)
}

/// Mark articles of a feed read (or, with `unread`, unread).
#[utoipa::path(post, path = "/rss/feeds/{id}/read", tag = "rss", params(RssFeedPath), request_body = RssReadRequest, responses((status = 204, description = "Marked.")))]
pub(crate) async fn mark_rss_read(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssFeedPath>,
    Json(req): Json<RssReadRequest>,
) -> ApiResult<StatusCode> {
    d.mark_rss_read(p.id, req.articles, !req.unread).await?;
    Ok(no_content())
}

/// Refresh several feeds now (also with `rss_enabled` off); `404` names the
/// first feed that does not exist, and nothing is refreshed then.
#[utoipa::path(post, path = "/rss/feeds/refresh", tag = "rss", request_body = RssFeedsRequest, responses((status = 202, description = "Refreshing.")))]
pub(crate) async fn refresh_rss_feeds(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFeedsRequest>,
) -> ApiResult<StatusCode> {
    d.refresh_rss_feeds(req.feeds).await?;
    Ok(StatusCode::ACCEPTED)
}

/// Mark every article of several feeds read.
#[utoipa::path(post, path = "/rss/feeds/read", tag = "rss", request_body = RssFeedsRequest, responses((status = 204, description = "Marked.")))]
pub(crate) async fn mark_rss_feeds_read(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFeedsRequest>,
) -> ApiResult<StatusCode> {
    d.mark_rss_feeds_read(req.feeds).await?;
    Ok(no_content())
}

/// Articles across feeds, newest first.
#[utoipa::path(get, path = "/rss/articles", tag = "rss", params(RssArticlesQuery), responses((status = 200, body = Vec<RssArticle>)))]
pub(crate) async fn list_rss_articles(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<RssArticlesQuery>,
) -> ApiResult<Json<Vec<RssArticle>>> {
    Ok(Json(d.rss_articles(q).await?))
}

/// Every folder (`tv`, `tv/anime`, ...).
#[utoipa::path(get, path = "/rss/folders", tag = "rss", responses((status = 200, body = Vec<String>)))]
pub(crate) async fn list_rss_folders(State(d): State<Arc<Daemon>>) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(d.rss_folders().await?))
}

/// Add a folder (and those above it).
#[utoipa::path(post, path = "/rss/folders", tag = "rss", request_body = RssFolderRequest, responses((status = 204, description = "Added.")))]
pub(crate) async fn add_rss_folder(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFolderRequest>,
) -> ApiResult<StatusCode> {
    d.add_rss_folder(&req.path).await?;
    Ok(no_content())
}

/// Remove a folder with its subfolders and their feeds.
#[utoipa::path(post, path = "/rss/folders/remove", tag = "rss", request_body = RssFolderRequest, responses((status = 204, description = "Removed.")))]
pub(crate) async fn remove_rss_folder(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFolderRequest>,
) -> ApiResult<StatusCode> {
    d.remove_rss_folder(&req.path).await?;
    Ok(no_content())
}

/// Move (rename) a folder with what is in it.
#[utoipa::path(post, path = "/rss/folders/move", tag = "rss", request_body = RssFolderMove, responses((status = 204, description = "Moved.")))]
pub(crate) async fn move_rss_folder(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssFolderMove>,
) -> ApiResult<StatusCode> {
    d.move_rss_folder(&req.from, &req.to).await?;
    Ok(no_content())
}

/// Every download rule.
#[utoipa::path(get, path = "/rss/rules", tag = "rss", responses((status = 200, body = Vec<RssRule>)))]
pub(crate) async fn list_rss_rules(State(d): State<Arc<Daemon>>) -> ApiResult<Json<Vec<RssRule>>> {
    Ok(Json(d.rss_rules().await?))
}

/// Create or replace a rule (its history is kept unless `reset_history`).
/// With `rss_auto_download` on, it runs over its feeds' articles at once.
#[utoipa::path(put, path = "/rss/rules/{name}", tag = "rss", params(RssRulePath), request_body = RssRuleRequest, responses((status = 200, body = RssRule)))]
pub(crate) async fn put_rss_rule(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssRulePath>,
    Json(req): Json<RssRuleRequest>,
) -> ApiResult<Json<RssRule>> {
    Ok(Json(d.put_rss_rule(&p.name, req).await?))
}

/// Remove a rule.
#[utoipa::path(delete, path = "/rss/rules/{name}", tag = "rss", params(RssRulePath), responses((status = 204, description = "Removed.")))]
pub(crate) async fn delete_rss_rule(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssRulePath>,
) -> ApiResult<StatusCode> {
    d.delete_rss_rule(&p.name).await?;
    Ok(no_content())
}

/// Rename a rule.
#[utoipa::path(post, path = "/rss/rules/{name}/rename", tag = "rss", params(RssRulePath), request_body = RssRuleRename, responses((status = 200, body = RssRule)))]
pub(crate) async fn rename_rss_rule(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssRulePath>,
    Json(req): Json<RssRuleRename>,
) -> ApiResult<Json<RssRule>> {
    Ok(Json(d.rename_rss_rule(&p.name, &req.name).await?))
}

/// A dry run of a rule as given (one being edited): every article of its
/// feeds, newest first, with what the rule would do and why its filters
/// leave an article. Nothing is saved or added, and no history applies.
#[utoipa::path(post, path = "/rss/dry-run", tag = "rss", request_body = RssRuleRequest, responses((status = 200, body = Vec<RssDryRunArticle>)))]
pub(crate) async fn dry_run_rss_rule(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RssRuleRequest>,
) -> ApiResult<Json<Vec<RssDryRunArticle>>> {
    Ok(Json(d.rss_rule_dry_run(req).await?))
}

/// The articles of the rule's feeds its filters take, newest first (a dry
/// run: its history is not applied).
#[utoipa::path(get, path = "/rss/rules/{name}/matches", tag = "rss", params(RssRulePath), responses((status = 200, body = Vec<RssArticle>)))]
pub(crate) async fn rss_rule_matches(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<RssRulePath>,
) -> ApiResult<Json<Vec<RssArticle>>> {
    Ok(Json(d.rss_rule_matches(&p.name).await?))
}
