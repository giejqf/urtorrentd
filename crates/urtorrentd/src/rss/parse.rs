// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Feed documents: RSS 2.0 (and the 0.9x / 1.0 item shape) and Atom, with
//! the torrent extensions indexers use (`enclosure`, `torznab:attr` /
//! `newznab:attr`, `torrent:magnetURI`, `torrent:contentLength`). Only what
//! the RSS features need is read; anything else is skipped.

use quick_xml::Reader;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};

/// Longest description kept, bytes.
const MAX_DESCRIPTION: usize = 16 * 1024;
/// Most items read from one document.
const MAX_ITEMS: usize = 1000;

/// A feed document.
#[derive(Debug, Default, PartialEq)]
pub struct ParsedFeed {
    /// The channel's title.
    pub title: Option<String>,
    /// Items in document order.
    pub items: Vec<ParsedItem>,
}

/// An item (RSS) or entry (Atom).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ParsedItem {
    /// `guid` / `id`.
    pub id: Option<String>,
    /// Title.
    pub title: Option<String>,
    /// Link.
    pub link: Option<String>,
    /// Published, unix seconds.
    pub date: Option<u64>,
    /// Description or summary (bounded).
    pub description: Option<String>,
    /// Author.
    pub author: Option<String>,
    /// Enclosure: URL, type.
    pub enclosure: Option<(String, Option<String>)>,
    /// A magnet link from the torrent extensions.
    pub magnet: Option<String>,
    /// Content size, bytes.
    pub size: Option<u64>,
}

impl ParsedItem {
    /// What to add: a `.torrent` enclosure, a magnet link, any enclosure,
    /// or the link.
    pub fn torrent_url(&self) -> Option<String> {
        let torrent_type = |t: &Option<String>| {
            t.as_deref()
                .is_some_and(|t| t.eq_ignore_ascii_case("application/x-bittorrent"))
        };
        match &self.enclosure {
            Some((url, t)) if torrent_type(t) => Some(url.clone()),
            _ => self
                .magnet
                .clone()
                .or_else(|| self.enclosure.as_ref().map(|(u, _)| u.clone()))
                .or_else(|| self.link.clone()),
        }
    }

    /// A stable identity within the feed: the `guid`, else the link, else
    /// the title and date.
    pub fn key(&self) -> String {
        self.id
            .clone()
            .or_else(|| self.link.clone())
            .unwrap_or_else(|| {
                format!(
                    "{}@{}",
                    self.title.as_deref().unwrap_or(""),
                    self.date.unwrap_or(0)
                )
            })
    }
}

fn date(s: &str) -> Option<u64> {
    let s = s.trim();
    let ts = jiff::fmt::rfc2822::parse(s)
        .map(|z| z.timestamp())
        .or_else(|_| s.parse::<jiff::Timestamp>())
        .ok()?;
    u64::try_from(ts.as_second()).ok()
}

fn bounded(mut s: String, max: usize) -> String {
    if s.len() > max {
        let mut end = max;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    s
}

fn local(e: &BytesStart<'_>) -> String {
    e.local_name().as_ref().to_ascii_lowercase()
}

fn attr(e: &BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        a.key
            .local_name()
            .as_ref()
            .eq_ignore_ascii_case(name)
            .then(|| {
                a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .ok()
                    .map(|v| v.trim().to_string())
            })
            .flatten()
    })
}

/// Read what an element's attributes say about the item it is in.
fn attributes(name: &str, e: &BytesStart<'_>, item: &mut ParsedItem) {
    match name {
        "enclosure" => {
            if let Some(url) = attr(e, "url").filter(|u| !u.is_empty()) {
                let t = attr(e, "type");
                let torrent = t
                    .as_deref()
                    .is_some_and(|t| t.eq_ignore_ascii_case("application/x-bittorrent"));
                // The first enclosure, unless a later one is the torrent.
                if item.enclosure.is_none() || torrent {
                    item.enclosure = Some((url, t));
                }
            }
            if item.size.is_none() {
                item.size = attr(e, "length")
                    .and_then(|l| l.parse().ok())
                    .filter(|&n| n > 0);
            }
        }
        "link" => {
            // Atom: `<link href="..." rel="..." type="..."/>`.
            if let Some(href) = attr(e, "href") {
                let rel = attr(e, "rel");
                let t = attr(e, "type");
                let torrent = t
                    .as_deref()
                    .is_some_and(|t| t.eq_ignore_ascii_case("application/x-bittorrent"));
                if rel.as_deref() == Some("enclosure") || torrent {
                    item.enclosure = Some((href, t));
                } else if rel.is_none() || rel.as_deref() == Some("alternate") {
                    item.link.get_or_insert(href);
                }
            }
        }
        "attr" => {
            // `torznab:attr` / `newznab:attr`.
            let (Some(n), Some(v)) = (attr(e, "name"), attr(e, "value")) else {
                return;
            };
            match n.to_ascii_lowercase().as_str() {
                "size" => item.size = item.size.or_else(|| v.parse().ok()),
                "magneturl" => item.magnet = item.magnet.clone().or(Some(v)),
                _ => {}
            }
        }
        _ => {}
    }
}

/// An element's text, once it closed.
fn text(name: &str, parent: &str, grandparent: &str, t: String, item: &mut ParsedItem) -> bool {
    let t = t.trim().to_string();
    if t.is_empty() {
        return true;
    }
    let in_item = matches!(parent, "item" | "entry");
    match name {
        "title" if in_item => item.title = Some(t),
        "link" if in_item => {
            item.link.get_or_insert(t);
        }
        "guid" | "id" if in_item => item.id = Some(t),
        "pubdate" | "published" if in_item => item.date = date(&t).or(item.date),
        "updated" | "date" if in_item => item.date = item.date.or_else(|| date(&t)),
        "description" | "summary" if in_item => {
            item.description = Some(bounded(t, MAX_DESCRIPTION))
        }
        "encoded" | "content" if in_item => {
            if item.description.is_none() {
                item.description = Some(bounded(t, MAX_DESCRIPTION));
            }
        }
        "author" | "creator" if in_item => {
            item.author.get_or_insert(t);
        }
        "name" if parent == "author" && matches!(grandparent, "item" | "entry") => {
            item.author.get_or_insert(t);
        }
        "magneturi" if in_item => {
            item.magnet.get_or_insert(t);
        }
        "contentlength" if in_item => item.size = item.size.or_else(|| t.parse().ok()),
        _ => return false,
    }
    true
}

/// Parse a feed document.
pub fn parse(bytes: &[u8]) -> Result<ParsedFeed, String> {
    let mut reader = Reader::from_reader(bytes);
    let mut feed = ParsedFeed::default();
    // The open elements and the text gathered in each.
    let mut stack: Vec<(String, String)> = Vec::new();
    let mut item: Option<ParsedItem> = None;
    let mut buf = Vec::new();
    let mut seen_root = false;
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("not a feed: {e}"))?;
        match event {
            Event::Start(e) => {
                let name = local(&e);
                if stack.is_empty() {
                    if !matches!(name.as_str(), "rss" | "feed" | "rdf") {
                        return Err(format!("not a feed: the document is <{name}>"));
                    }
                    seen_root = true;
                }
                if matches!(name.as_str(), "item" | "entry") {
                    item = Some(ParsedItem::default());
                } else if let Some(it) = item.as_mut() {
                    attributes(&name, &e, it);
                }
                stack.push((name, String::new()));
            }
            Event::Empty(e) => {
                if let Some(it) = item.as_mut() {
                    attributes(&local(&e), &e, it);
                }
            }
            Event::Text(t) => {
                if let Some((_, s)) = stack.last_mut() {
                    s.push_str(&t.into_inner());
                }
            }
            Event::CData(c) => {
                if let Some((_, s)) = stack.last_mut() {
                    s.push_str(&c.into_inner());
                }
            }
            Event::GeneralRef(r) => {
                if let Some((_, s)) = stack.last_mut() {
                    match r.resolve_char_ref() {
                        Ok(Some(c)) => s.push(c),
                        _ => {
                            let name = r.into_inner();
                            match resolve_predefined_entity(&name) {
                                Some(v) => s.push_str(v),
                                None => {
                                    s.push('&');
                                    s.push_str(&name);
                                    s.push(';');
                                }
                            }
                        }
                    }
                }
            }
            Event::End(_) => {
                let Some((name, t)) = stack.pop() else {
                    continue;
                };
                let parent = stack.last().map_or("", |(n, _)| n.as_str()).to_string();
                let grandparent = stack
                    .len()
                    .checked_sub(2)
                    .map_or("", |i| stack[i].0.as_str())
                    .to_string();
                if matches!(name.as_str(), "item" | "entry") {
                    if let Some(it) = item.take()
                        && (it.title.is_some() || it.torrent_url().is_some())
                        && feed.items.len() < MAX_ITEMS
                    {
                        feed.items.push(it);
                    }
                    continue;
                }
                if name == "title" && matches!(parent.as_str(), "channel" | "feed") {
                    feed.title = Some(t.trim().to_string()).filter(|t| !t.is_empty());
                    continue;
                }
                let used = match item.as_mut() {
                    Some(it) => text(&name, &parent, &grandparent, t.clone(), it),
                    None => false,
                };
                // Markup inside a text element (XHTML in Atom): its text
                // belongs to the enclosing element.
                if !used && let Some((_, s)) = stack.last_mut() {
                    s.push_str(&t);
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !seen_root {
        return Err("not a feed: the document is empty".into());
    }
    Ok(feed)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn rss_with_torznab() {
        let doc = br#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel><title>Indexer &amp; Co</title>
<item>
  <title>Show.S01E02.1080p.WEB</title>
  <guid isPermaLink="false">abc-123</guid>
  <link>https://indexer.example/details/123</link>
  <pubDate>Tue, 15 Sep 2026 10:30:00 +0000</pubDate>
  <description><![CDATA[<b>Nice</b> &amp; clean]]></description>
  <enclosure url="https://indexer.example/dl/123.torrent?passkey=x" length="734003200" type="application/x-bittorrent"/>
  <torznab:attr name="size" value="999"/>
  <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"/>
</item>
<item><title>Only a magnet &#x2713;</title><link>magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff</link></item>
<item><description>no title, no link: skipped</description></item>
</channel></rss>"#;
        let f = parse(doc).unwrap();
        assert_eq!(f.title.as_deref(), Some("Indexer & Co"));
        assert_eq!(f.items.len(), 2);
        let a = &f.items[0];
        assert_eq!(a.key(), "abc-123");
        assert_eq!(a.title.as_deref(), Some("Show.S01E02.1080p.WEB"));
        assert_eq!(a.date, Some(1_789_468_200));
        assert_eq!(a.description.as_deref(), Some("<b>Nice</b> &amp; clean"));
        assert_eq!(a.size, Some(734_003_200), "the enclosure's length first");
        assert_eq!(
            a.torrent_url().as_deref(),
            Some("https://indexer.example/dl/123.torrent?passkey=x")
        );
        let b = &f.items[1];
        assert_eq!(b.title.as_deref(), Some("Only a magnet \u{2713}"));
        assert!(b.torrent_url().unwrap().starts_with("magnet:"));
        assert_eq!(b.key(), b.link.clone().unwrap());
    }

    #[test]
    fn atom() {
        let doc = br#"<feed xmlns="http://www.w3.org/2005/Atom"><title>Releases</title>
<entry><title>Distro 26.04</title><id>urn:uuid:1</id>
  <link rel="alternate" href="https://distro.example/news/1"/>
  <link rel="enclosure" type="application/x-bittorrent" href="https://distro.example/26.04.torrent"/>
  <updated>2026-04-20T12:00:00Z</updated>
  <author><name>Release Team</name></author>
  <content type="xhtml"><div>It is <em>out</em></div></content>
</entry></feed>"#;
        let f = parse(doc).unwrap();
        assert_eq!(f.title.as_deref(), Some("Releases"));
        let e = &f.items[0];
        assert_eq!(e.key(), "urn:uuid:1");
        assert_eq!(e.link.as_deref(), Some("https://distro.example/news/1"));
        assert_eq!(
            e.torrent_url().as_deref(),
            Some("https://distro.example/26.04.torrent")
        );
        assert_eq!(e.date, Some(1_776_686_400));
        assert_eq!(e.author.as_deref(), Some("Release Team"));
        assert_eq!(e.description.as_deref(), Some("It is out"));
    }

    #[test]
    fn not_feeds() {
        assert!(parse(b"<html><body>login</body></html>").is_err());
        assert!(parse(b"").is_err());
        // Cut short: what closed is kept.
        let f = parse(b"<rss><channel><title>t</title><item><title>x</title>").unwrap();
        assert_eq!(f.title.as_deref(), Some("t"));
        assert!(f.items.is_empty());
    }
}
