// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! RSS in `urtorrentd.db` (schema version 2): folders, feeds, their
//! articles (the newest `rss_max_articles` per feed), and the download
//! rules (JSON).

use std::io;

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use super::parse::ParsedItem;
use crate::model::{RssArticle, RssRule};
use crate::store::db_err;

/// A feed as stored, with its article counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedRow {
    pub id: u32,
    pub url: String,
    pub name: Option<String>,
    pub folder: Option<String>,
    pub refresh_interval: Option<u64>,
    pub title: Option<String>,
    pub last_refresh: Option<u64>,
    pub error: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub articles: u32,
    pub unread: u32,
}

const FEED_COLUMNS: &str = "f.id, f.url, f.name, f.folder, f.refresh_interval, f.title,
    f.last_refresh, f.error, f.etag, f.last_modified,
    (SELECT count(*) FROM rss_articles a WHERE a.feed = f.id),
    (SELECT count(*) FROM rss_articles a WHERE a.feed = f.id AND a.read = 0)";

fn feed_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<FeedRow> {
    Ok(FeedRow {
        id: r.get(0)?,
        url: r.get(1)?,
        name: r.get(2)?,
        folder: r.get(3)?,
        refresh_interval: r.get(4)?,
        title: r.get(5)?,
        last_refresh: r.get(6)?,
        error: r.get(7)?,
        etag: r.get(8)?,
        last_modified: r.get(9)?,
        articles: r.get(10)?,
        unread: r.get(11)?,
    })
}

/// Every feed, by id.
pub fn feeds(c: &Connection) -> io::Result<Vec<FeedRow>> {
    let mut stmt = c
        .prepare_cached(&format!(
            "SELECT {FEED_COLUMNS} FROM rss_feeds f ORDER BY f.id"
        ))
        .map_err(db_err)?;
    stmt.query_map([], feed_row)
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
}

/// One feed.
pub fn feed(c: &Connection, id: u32) -> io::Result<Option<FeedRow>> {
    c.query_row(
        &format!("SELECT {FEED_COLUMNS} FROM rss_feeds f WHERE f.id = ?1"),
        params![id],
        feed_row,
    )
    .optional()
    .map_err(db_err)
}

/// A feed with this URL, if any.
pub fn feed_by_url(c: &Connection, url: &str) -> io::Result<Option<u32>> {
    c.query_row(
        "SELECT id FROM rss_feeds WHERE url = ?1",
        params![url],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_err)
}

/// A folder and every folder above it.
fn ensure_folder(tx: &Transaction<'_>, path: &str) -> io::Result<()> {
    let mut at = String::new();
    for seg in path.split('/') {
        if !at.is_empty() {
            at.push('/');
        }
        at.push_str(seg);
        tx.execute(
            "INSERT INTO rss_folders (path) VALUES (?1) ON CONFLICT DO NOTHING",
            params![at],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// Add a feed; returns its id.
pub fn insert_feed(
    tx: &Transaction<'_>,
    url: &str,
    name: Option<&str>,
    folder: Option<&str>,
    refresh_interval: Option<u64>,
) -> io::Result<u32> {
    if let Some(f) = folder {
        ensure_folder(tx, f)?;
    }
    tx.query_row(
        "INSERT INTO rss_feeds (url, name, folder, refresh_interval) VALUES (?1, ?2, ?3, ?4)
         RETURNING id",
        params![url, name, folder, refresh_interval],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// Change a feed (the fields given).
pub fn update_feed(
    tx: &Transaction<'_>,
    id: u32,
    url: &str,
    name: Option<&str>,
    folder: Option<&str>,
    refresh_interval: Option<u64>,
) -> io::Result<()> {
    if let Some(f) = folder {
        ensure_folder(tx, f)?;
    }
    tx.execute(
        "UPDATE rss_feeds SET url = ?2, name = ?3, folder = ?4, refresh_interval = ?5 WHERE id = ?1",
        params![id, url, name, folder, refresh_interval],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Remove a feed and its articles.
pub fn delete_feed(tx: &Transaction<'_>, id: u32) -> io::Result<bool> {
    tx.execute("DELETE FROM rss_articles WHERE feed = ?1", params![id])
        .map_err(db_err)?;
    Ok(tx
        .execute("DELETE FROM rss_feeds WHERE id = ?1", params![id])
        .map_err(db_err)?
        > 0)
}

/// Every folder, sorted.
pub fn folders(c: &Connection) -> io::Result<Vec<String>> {
    let mut stmt = c
        .prepare_cached("SELECT path FROM rss_folders ORDER BY path")
        .map_err(db_err)?;
    stmt.query_map([], |r| r.get(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
}

/// Add a folder (and those above it).
pub fn add_folder(tx: &Transaction<'_>, path: &str) -> io::Result<()> {
    ensure_folder(tx, path)
}

/// SQL: `col` is the folder `?1` or one under it.
fn under(col: &str) -> String {
    format!("(?1 = {col} OR substr({col}, 1, length(?1) + 1) = ?1 || '/')")
}

/// Remove a folder, the folders under it and their feeds; returns the
/// feeds removed, or `None` if there was no such folder.
pub fn remove_folder(tx: &Transaction<'_>, path: &str) -> io::Result<Option<Vec<u32>>> {
    let exists: bool = tx
        .query_row(
            &format!(
                "SELECT count(*) > 0 FROM rss_folders WHERE {}",
                under("path")
            ),
            params![path],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !exists {
        return Ok(None);
    }
    let ids: Vec<u32> = {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT id FROM rss_feeds WHERE folder IS NOT NULL AND {}",
                under("folder")
            ))
            .map_err(db_err)?;
        stmt.query_map(params![path], |r| r.get(0))
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?
    };
    for id in &ids {
        delete_feed(tx, *id)?;
    }
    tx.execute(
        &format!("DELETE FROM rss_folders WHERE {}", under("path")),
        params![path],
    )
    .map_err(db_err)?;
    Ok(Some(ids))
}

/// Move a folder with what is in it; `false` if there was no such folder.
pub fn move_folder(tx: &Transaction<'_>, from: &str, to: &str) -> io::Result<bool> {
    let exists: bool = tx
        .query_row(
            "SELECT count(*) > 0 FROM rss_folders WHERE path = ?1",
            params![from],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !exists {
        return Ok(false);
    }
    ensure_folder(tx, to)?;
    for (table, col) in [("rss_folders", "path"), ("rss_feeds", "folder")] {
        tx.execute(
            &format!(
                "UPDATE OR IGNORE {table} SET {col} = ?2 || substr({col}, length(?1) + 1)
                 WHERE {col} IS NOT NULL AND {}",
                under(col)
            ),
            params![from, to],
        )
        .map_err(db_err)?;
    }
    // Paths that already existed under `to` were kept; drop the old ones.
    tx.execute(
        &format!("DELETE FROM rss_folders WHERE {}", under("path")),
        params![from],
    )
    .map_err(db_err)?;
    Ok(true)
}

/// Record a refresh: the feed's title and validators, and its items (new
/// ones added, known ones updated, the oldest beyond `keep` dropped).
/// Returns the ids of the new articles.
#[allow(clippy::too_many_arguments)]
pub fn save_refresh(
    tx: &Transaction<'_>,
    feed: u32,
    now: u64,
    title: Option<&str>,
    etag: Option<&str>,
    last_modified: Option<&str>,
    items: &[ParsedItem],
    keep: u32,
) -> io::Result<Vec<String>> {
    tx.execute(
        "UPDATE rss_feeds SET title = coalesce(?2, title), last_refresh = ?3, error = NULL,
             etag = ?4, last_modified = ?5 WHERE id = ?1",
        params![feed, title, now, etag, last_modified],
    )
    .map_err(db_err)?;
    let mut seq: u64 = tx
        .query_row("SELECT coalesce(max(seq), 0) FROM rss_articles", [], |r| {
            r.get(0)
        })
        .map_err(db_err)?;
    let mut new = Vec::new();
    // Documents list the newest first: insert oldest first, so the newest
    // gets the highest sequence number.
    for it in items.iter().rev() {
        let id = it.key();
        let known: bool = tx
            .query_row(
                "SELECT count(*) > 0 FROM rss_articles WHERE feed = ?1 AND id = ?2",
                params![feed, id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let title = it.title.clone().unwrap_or_default();
        if known {
            tx.execute(
                "UPDATE rss_articles SET title = ?3, date = coalesce(?4, date), link = ?5,
                     torrent_url = ?6, description = ?7, author = ?8, size = ?9
                 WHERE feed = ?1 AND id = ?2",
                params![
                    feed,
                    id,
                    title,
                    it.date,
                    it.link,
                    it.torrent_url(),
                    it.description,
                    it.author,
                    it.size
                ],
            )
            .map_err(db_err)?;
            continue;
        }
        seq += 1;
        tx.execute(
            "INSERT INTO rss_articles (feed, id, seq, date, title, link, torrent_url,
                 description, author, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                feed,
                id,
                seq,
                it.date,
                title,
                it.link,
                it.torrent_url(),
                it.description,
                it.author,
                it.size
            ],
        )
        .map_err(db_err)?;
        new.push(id);
    }
    tx.execute(
        "DELETE FROM rss_articles WHERE feed = ?1 AND seq NOT IN
             (SELECT seq FROM rss_articles WHERE feed = ?1 ORDER BY seq DESC LIMIT ?2)",
        params![feed, keep],
    )
    .map_err(db_err)?;
    // New articles dropped at once (more than `keep` in one document) are
    // not new.
    let mut kept = Vec::new();
    for id in new {
        let still: bool = tx
            .query_row(
                "SELECT count(*) > 0 FROM rss_articles WHERE feed = ?1 AND id = ?2",
                params![feed, id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if still {
            kept.push(id);
        }
    }
    Ok(kept)
}

/// Record a failed refresh.
pub fn save_error(c: &Connection, feed: u32, now: u64, error: &str) -> io::Result<()> {
    c.execute(
        "UPDATE rss_feeds SET last_refresh = ?2, error = ?3 WHERE id = ?1",
        params![feed, now, error],
    )
    .map_err(db_err)?;
    Ok(())
}

fn article_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RssArticle> {
    Ok(RssArticle {
        feed: r.get(0)?,
        id: r.get(1)?,
        date: r.get(2)?,
        title: r.get(3)?,
        link: r.get(4)?,
        torrent_url: r.get(5)?,
        description: r.get(6)?,
        author: r.get(7)?,
        size: r.get(8)?,
        read: r.get(9)?,
        downloaded: r.get(10)?,
        matched_rule: None,
    })
}

/// Articles, newest first.
pub fn articles(
    c: &Connection,
    feed: Option<u32>,
    unread_only: bool,
    limit: u32,
) -> io::Result<Vec<RssArticle>> {
    let mut stmt = c
        .prepare_cached(
            "SELECT feed, id, date, title, link, torrent_url, description, author, size, read,
                 downloaded
             FROM rss_articles
             WHERE (?1 IS NULL OR feed = ?1) AND (?2 = 0 OR read = 0)
             ORDER BY seq DESC LIMIT ?3",
        )
        .map_err(db_err)?;
    stmt.query_map(params![feed, unread_only, limit], article_row)
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
}

/// Mark articles read, or unread (`None` = all of the feed); returns how
/// many.
pub fn mark_read(
    tx: &Transaction<'_>,
    feed: u32,
    ids: Option<&[String]>,
    read: bool,
) -> io::Result<usize> {
    match ids {
        None => tx
            .execute(
                "UPDATE rss_articles SET read = ?2 WHERE feed = ?1",
                params![feed, read],
            )
            .map_err(db_err),
        Some(ids) => {
            let mut n = 0;
            for id in ids {
                n += tx
                    .execute(
                        "UPDATE rss_articles SET read = ?3 WHERE feed = ?1 AND id = ?2",
                        params![feed, id, read],
                    )
                    .map_err(db_err)?;
            }
            Ok(n)
        }
    }
}

/// An article was added by a rule: downloaded, and read.
pub fn mark_downloaded(c: &Connection, feed: u32, id: &str) -> io::Result<()> {
    c.execute(
        "UPDATE rss_articles SET downloaded = 1, read = 1 WHERE feed = ?1 AND id = ?2",
        params![feed, id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Every rule, by name.
pub fn rules(c: &Connection) -> io::Result<Vec<RssRule>> {
    let mut stmt = c
        .prepare_cached("SELECT rule FROM rss_rules ORDER BY name")
        .map_err(db_err)?;
    let raw = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)?;
    Ok(raw
        .iter()
        .filter_map(|j| serde_json::from_str(j).ok())
        .collect())
}

/// Store a rule (replacing one of that name).
pub fn put_rule(c: &Connection, rule: &RssRule) -> io::Result<()> {
    let json = serde_json::to_string(rule).map_err(io::Error::other)?;
    c.execute(
        "INSERT INTO rss_rules (name, rule) VALUES (?1, ?2)
         ON CONFLICT(name) DO UPDATE SET rule = excluded.rule",
        params![rule.name, json],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Remove a rule; whether there was one.
pub fn delete_rule(c: &Connection, name: &str) -> io::Result<bool> {
    Ok(
        c.execute("DELETE FROM rss_rules WHERE name = ?1", params![name])
            .map_err(db_err)?
            > 0,
    )
}
