// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! RSS download rules: which article titles a rule takes. The rules follow
//! qBittorrent's (its documentation, not its code):
//!
//! - `must_contain` / `must_not_contain`: with `use_regex`, a regular
//!   expression; otherwise wildcards, where `*` is any text, `?` any one
//!   character, spaces separate words that must all appear (in any order)
//!   and `|` separates alternatives. Case does not matter. An empty
//!   `must_contain` takes everything.
//! - `episode_filter`: `1x2;1x8-15;2x1-;` takes season 1 episode 2, season 1
//!   episodes 8 to 15, and season 2 from episode 1 on (with every later
//!   season). An item without a season (`8-15;`) keeps the previous one's.
//! - `smart_filter`: an episode (`S01E02`, `1x02`, or a date) is taken once;
//!   with the `rss_download_repacks` setting a REPACK or PROPER of it is
//!   taken once more.
//! - `ignore_days`: after a match, nothing more for that many days.

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

use crate::model::RssRule;

/// Largest compiled regular expression.
const REGEX_SIZE: usize = 1 << 20;

fn regex(pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(REGEX_SIZE)
        .build()
        .map_err(|e| format!("{pattern:?}: {e}"))
}

/// A wildcard word as a regular expression (unanchored).
fn wildcard(word: &str) -> String {
    let mut out = String::new();
    for c in word.chars() {
        match c {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            c => out.push_str(&regex::escape(&c.to_string())),
        }
    }
    out
}

/// A `must_contain` / `must_not_contain` expression, compiled.
enum Terms {
    Empty,
    Regex(Regex),
    /// Alternatives, each a list of words (as typed, compiled) that must
    /// all appear.
    Wildcards(Vec<Vec<(String, Regex)>>),
}

impl Terms {
    fn new(s: &str, use_regex: bool) -> Result<Terms, String> {
        let s = s.trim();
        if s.is_empty() {
            return Ok(Terms::Empty);
        }
        if use_regex {
            return regex(s).map(Terms::Regex);
        }
        let mut alts = Vec::new();
        for alt in s.split('|') {
            let words = alt
                .split_whitespace()
                .map(|w| regex(&wildcard(w)).map(|r| (w.to_string(), r)))
                .collect::<Result<Vec<_>, _>>()?;
            if !words.is_empty() {
                alts.push(words);
            }
        }
        Ok(if alts.is_empty() {
            Terms::Empty
        } else {
            Terms::Wildcards(alts)
        })
    }

    /// Whether `title` matches (`None` for an empty expression).
    fn matches(&self, title: &str) -> Option<bool> {
        match self {
            Terms::Empty => None,
            Terms::Regex(r) => Some(r.is_match(title)),
            Terms::Wildcards(alts) => Some(
                alts.iter()
                    .any(|words| words.iter().all(|(_, w)| w.is_match(title))),
            ),
        }
    }

    /// What `title` lacks, when it does not match: the expression, or the
    /// words missing from the alternative it comes closest to.
    fn missing(&self, title: &str) -> String {
        match self {
            Terms::Empty => String::new(),
            Terms::Regex(r) => r.as_str().to_string(),
            Terms::Wildcards(alts) => alts
                .iter()
                .map(|words| {
                    words
                        .iter()
                        .filter(|(_, w)| !w.is_match(title))
                        .map(|(s, _)| s.as_str())
                        .collect::<Vec<_>>()
                })
                .min_by_key(Vec::len)
                .unwrap_or_default()
                .join(" "),
        }
    }

    /// What in `title` matches, when it does: the expression, or the words
    /// of the first alternative found.
    fn found(&self, title: &str) -> String {
        match self {
            Terms::Empty => String::new(),
            Terms::Regex(r) => r.as_str().to_string(),
            Terms::Wildcards(alts) => alts
                .iter()
                .find(|words| words.iter().all(|(_, w)| w.is_match(title)))
                .map(|words| {
                    words
                        .iter()
                        .map(|(s, _)| s.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
        }
    }
}

/// One item of an episode filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Range {
    season: u32,
    from: u32,
    /// `None` = open: this episode on, and every later season.
    to: Option<u32>,
}

fn episode_filter(s: &str) -> Result<Vec<Range>, String> {
    let bad =
        |item: &str| format!("episode filter item {item:?}: expected like 1x2, 1x8-15 or 1x3-");
    let mut out = Vec::new();
    let mut season = None;
    for item in s.split(';').map(str::trim).filter(|i| !i.is_empty()) {
        let (s, eps) = match item.split_once(['x', 'X']) {
            Some((s, e)) => (Some(s.trim().parse::<u32>().map_err(|_| bad(item))?), e),
            None => (None, item),
        };
        let season = match s.or(season) {
            Some(n) if n > 0 => {
                season = Some(n);
                n
            }
            _ => return Err(bad(item)),
        };
        let (from, to) = match eps.split_once('-') {
            Some((a, "")) => (a.trim().parse().map_err(|_| bad(item))?, None),
            Some((a, b)) => {
                let (a, b): (u32, u32) = (
                    a.trim().parse().map_err(|_| bad(item))?,
                    b.trim().parse().map_err(|_| bad(item))?,
                );
                if b < a {
                    return Err(bad(item));
                }
                (a, Some(b))
            }
            None => {
                let n = eps.trim().parse().map_err(|_| bad(item))?;
                (n, Some(n))
            }
        };
        out.push(Range { season, from, to });
    }
    Ok(out)
}

/// What a title says about its episode.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Episode {
    /// Season and episodes (one, or a run for a multi-episode release).
    Numbered { season: u32, episodes: Vec<u32> },
    /// A date (daily shows): `YYYY-MM-DD`.
    Dated(String),
}

static SXE: LazyLock<Option<Regex>> =
    LazyLock::new(|| regex(r"\bs(\d{1,4})[ ._-]?e(\d{1,4})(?:[ ._-]?-?[ ._-]?e(\d{1,4}))?").ok());
static NXN: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"\b(\d{1,2})x(\d{1,3})\b").ok());
static DATE: LazyLock<Option<Regex>> =
    LazyLock::new(|| regex(r"\b((?:19|20)\d{2})[. _-](\d{2})[. _-](\d{2})\b").ok());
static REPACK: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"\b(repack|proper)\b").ok());

fn episode(title: &str) -> Option<Episode> {
    let num = |m: Option<regex::Match<'_>>| m.and_then(|m| m.as_str().parse::<u32>().ok());
    if let Some(c) = SXE.as_ref().and_then(|r| r.captures(title)) {
        let season = num(c.get(1))?;
        let first = num(c.get(2))?;
        let last = num(c.get(3))
            .filter(|&l| l >= first && l - first < 100)
            .unwrap_or(first);
        return Some(Episode::Numbered {
            season,
            episodes: (first..=last).collect(),
        });
    }
    if let Some(c) = NXN.as_ref().and_then(|r| r.captures(title)) {
        return Some(Episode::Numbered {
            season: num(c.get(1))?,
            episodes: vec![num(c.get(2))?],
        });
    }
    DATE.as_ref()
        .and_then(|r| r.captures(title))
        .map(|c| Episode::Dated(format!("{}-{}-{}", &c[1], &c[2], &c[3])))
}

fn in_filter(ranges: &[Range], season: u32, ep: u32) -> bool {
    ranges.iter().any(|r| match r.to {
        Some(to) => season == r.season && (r.from..=to).contains(&ep),
        None => (season == r.season && ep >= r.from) || season > r.season,
    })
}

/// A rule, compiled.
pub struct Matcher {
    must: Terms,
    must_not: Terms,
    episodes: Vec<Range>,
}

impl Matcher {
    /// Compile a rule; the errors are the user's (bad expressions).
    pub fn new(rule: &RssRule) -> Result<Matcher, String> {
        Ok(Matcher {
            must: Terms::new(&rule.must_contain, rule.use_regex)
                .map_err(|e| format!("must_contain {e}"))?,
            must_not: Terms::new(&rule.must_not_contain, rule.use_regex)
                .map_err(|e| format!("must_not_contain {e}"))?,
            episodes: episode_filter(&rule.episode_filter)?,
        })
    }

    /// Whether `rule` takes the article `title` at `now`: `None` = no;
    /// `Some(key)` = yes, with the episode to remember (smart filter).
    pub fn take(
        &self,
        rule: &RssRule,
        title: &str,
        now: u64,
        repacks: bool,
    ) -> Option<Option<String>> {
        self.judge(rule, title, now, repacks).ok()
    }

    /// [`Matcher::take`], saying why when the rule leaves the article.
    pub fn judge(
        &self,
        rule: &RssRule,
        title: &str,
        now: u64,
        repacks: bool,
    ) -> Result<Option<String>, String> {
        if !rule.enabled {
            return Err("the rule is off".to_string());
        }
        if rule.ignore_days > 0
            && rule
                .last_match
                .is_some_and(|t| now.saturating_sub(t) < u64::from(rule.ignore_days) * 86_400)
        {
            return Err(format!(
                "ignored for {} days after the last match",
                rule.ignore_days
            ));
        }
        if self.must.matches(title) == Some(false) {
            return Err(format!("does not match: {}", self.must.missing(title)));
        }
        if self.must_not.matches(title) == Some(true) {
            return Err(format!(
                "excluded by must not contain: {}",
                self.must_not.found(title)
            ));
        }
        let ep = episode(title);
        if !self.episodes.is_empty() {
            match &ep {
                Some(Episode::Numbered { season, episodes })
                    if episodes
                        .iter()
                        .any(|&e| in_filter(&self.episodes, *season, e)) => {}
                Some(Episode::Numbered { season, episodes }) => {
                    let first = episodes.first().copied().unwrap_or_default();
                    return Err(format!(
                        "episode {season}x{first} is not in the episode filter"
                    ));
                }
                _ => return Err("no episode number for the episode filter".to_string()),
            }
        }
        if !rule.smart_filter {
            return Ok(None);
        }
        let Some(ep) = ep else {
            return Ok(None);
        };
        let mut key = match ep {
            Episode::Numbered { season, episodes } => episodes
                .iter()
                .map(|e| format!("{season}x{e}"))
                .collect::<Vec<_>>()
                .join("+"),
            Episode::Dated(d) => d,
        };
        if repacks && REPACK.as_ref().is_some_and(|r| r.is_match(title)) {
            key.push_str(":repack");
        }
        if rule.matched_episodes.contains(&key) {
            return Err(format!("episode {key} was taken before (smart filter)"));
        }
        Ok(Some(key))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn rule(must: &str, must_not: &str, re: bool, eps: &str, smart: bool) -> RssRule {
        RssRule {
            name: "r".into(),
            enabled: true,
            must_contain: must.into(),
            must_not_contain: must_not.into(),
            use_regex: re,
            episode_filter: eps.into(),
            smart_filter: smart,
            feeds: vec![1],
            ignore_days: 0,
            add_options: Default::default(),
            last_match: None,
            matched_episodes: Vec::new(),
        }
    }

    fn takes(r: &RssRule, title: &str) -> bool {
        Matcher::new(r)
            .unwrap()
            .take(r, title, 1_000_000, true)
            .is_some()
    }

    #[test]
    fn wildcards_and_regexes() {
        let r = rule("show* 1080p | film ?ame", "cam", false, "", false);
        assert!(takes(&r, "The.Showcase.S01E01.1080p"));
        assert!(takes(&r, "1080P SHOWS"), "any order, any case");
        assert!(takes(&r, "Film Game 2026"));
        assert!(!takes(&r, "The.Show.720p"));
        assert!(!takes(&r, "Show 1080p CAM"));
        assert!(takes(&rule("", "", false, "", false), "anything"));
        let r = rule(r"^Show\.S\d+E\d+", r"(?:720p|480p)", true, "", false);
        assert!(takes(&r, "Show.S02E03.1080p"));
        assert!(!takes(&r, "Show.S02E03.720p"));
        assert!(!takes(&r, "The.Show.S02E03"));
        assert!(Matcher::new(&rule("(", "", true, "", false)).is_err());
    }

    #[test]
    fn episode_filters() {
        let r = rule("show", "", false, "1x2;8-15;2x3-;", false);
        assert!(takes(&r, "Show S01E02"));
        assert!(takes(&r, "Show 1x09"));
        assert!(!takes(&r, "Show S01E03"));
        assert!(!takes(&r, "Show S02E02"));
        assert!(takes(&r, "Show S02E03"));
        assert!(
            takes(&r, "Show S05E01"),
            "an open range takes later seasons"
        );
        assert!(
            takes(&r, "Show S01E01-E02"),
            "a multi-episode release with one wanted"
        );
        assert!(!takes(&r, "Show 2026.09.24"), "no episode number");
        for bad in ["x2;", "0x1;", "1x;", "1x5-3;", "one"] {
            assert!(
                Matcher::new(&rule("", "", false, bad, false)).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_smart_filter_takes_an_episode_once() {
        let mut r = rule("show", "", false, "", true);
        let m = Matcher::new(&r).unwrap();
        let key = m.take(&r, "Show.S01E02.720p", 0, true).unwrap().unwrap();
        assert_eq!(key, "1x2");
        r.matched_episodes.push(key);
        assert!(m.take(&r, "Show.S01E02.1080p", 0, true).is_none());
        let repack = m
            .take(&r, "Show.S01E02.REPACK.1080p", 0, true)
            .unwrap()
            .unwrap();
        assert_eq!(repack, "1x2:repack");
        assert!(
            m.take(&r, "Show.S01E02.REPACK.1080p", 0, false).is_none(),
            "repacks off: the same episode"
        );
        r.matched_episodes.push(repack);
        assert!(m.take(&r, "Show.S01E02.PROPER", 0, true).is_none());
        assert_eq!(
            m.take(&r, "Show 2026-09-24 Guest", 0, true)
                .unwrap()
                .unwrap(),
            "2026-09-24"
        );
        assert_eq!(
            m.take(&r, "Show special", 0, true),
            Some(None),
            "nothing to remember"
        );
    }

    #[test]
    fn ignore_days_and_enabled() {
        let mut r = rule("", "", false, "", false);
        r.ignore_days = 2;
        r.last_match = Some(1_000_000 - 86_400);
        assert!(!takes(&r, "x"));
        r.last_match = Some(1_000_000 - 3 * 86_400);
        assert!(takes(&r, "x"));
        r.enabled = false;
        assert!(!takes(&r, "x"));
    }
}
