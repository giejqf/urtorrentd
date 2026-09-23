// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Categories, tags and automatic management (the save path follows the
//! category). All of it is frontend policy (`docs/config.md` in urtorrent):
//! state the daemon keeps, applied through `move_storage`.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

use urtorrent::{InfoHash, TorrentId};

use super::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::store::{Categories, Category, Tags};
use crate::util::blocking;

/// Validate a category name: `a`, `a/b`; no empty segments, no backslashes.
pub(crate) fn check_category_name(name: &str) -> ApiResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && !name.contains('\\')
        && name.split('/').all(|s| !s.is_empty() && s.trim() == s);
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "{name:?} is not a valid category name"
        )))
    }
}

/// Validate a tag: non-empty, no commas, no surrounding spaces.
pub(crate) fn check_tag(tag: &str) -> ApiResult<()> {
    if tag.is_empty() || tag.len() > 255 || tag.contains(',') || tag.trim() != tag {
        return Err(ApiError::bad_request(format!("{tag:?} is not a valid tag")));
    }
    Ok(())
}

fn join(base: &str, rel: &str) -> String {
    Path::new(base).join(rel).to_string_lossy().into_owned()
}

fn check_category_paths(c: &Category) -> ApiResult<()> {
    for p in [&c.save_path, &c.download_path].into_iter().flatten() {
        if p.is_empty() || p.contains('\0') {
            return Err(ApiError::bad_request("category paths must not be empty"));
        }
    }
    Ok(())
}

impl Daemon {
    /// The save path automatic management gives a torrent in `category`.
    pub(crate) fn category_save_path(&self, category: Option<&str>) -> String {
        let st = self.state();
        let base = &st.settings.save_path;
        match category {
            None => base.clone(),
            Some(c) => match st.categories.get(c).and_then(|x| x.save_path.as_deref()) {
                Some(p) if Path::new(p).is_absolute() => p.to_string(),
                Some(p) => join(base, p),
                None => join(base, c),
            },
        }
    }

    /// The download path automatic management gives a torrent in `category`.
    pub(crate) fn category_download_path(&self, category: Option<&str>) -> Option<String> {
        let st = self.state();
        let global = st.settings.download_path.clone();
        let own = category.and_then(|c| st.categories.get(c)?.download_path.clone());
        match own {
            Some(p) if Path::new(&p).is_absolute() => Some(p),
            Some(p) => global.map(|g| join(&g, &p)),
            None => global,
        }
    }

    async fn save_categories(&self) -> ApiResult<()> {
        let cats = self.state().categories.clone();
        let s = self.store.clone();
        blocking(move || s.save_categories(&cats)).await?;
        Ok(())
    }

    async fn save_tags(&self) -> ApiResult<()> {
        let tags = self.state().tags.clone();
        let s = self.store.clone();
        blocking(move || s.save_tags(&tags)).await?;
        Ok(())
    }

    /// The categories.
    pub(crate) fn categories(&self) -> Categories {
        self.state().categories.clone()
    }

    /// The tags.
    pub(crate) fn tags(&self) -> Tags {
        self.state().tags.clone()
    }

    /// Create `name` with default paths if it does not exist.
    pub(crate) async fn ensure_category(&self, name: &str) -> ApiResult<()> {
        check_category_name(name)?;
        let created = {
            let mut st = self.state();
            if st.categories.contains_key(name) {
                false
            } else {
                st.categories.insert(name.to_string(), Category::default());
                true
            }
        };
        if created {
            self.save_categories().await?;
        }
        Ok(())
    }

    /// Create the tags that do not exist yet.
    pub(crate) async fn ensure_tags(&self, tags: &[String]) -> ApiResult<()> {
        for t in tags {
            check_tag(t)?;
        }
        let created = {
            let mut st = self.state();
            let before = st.tags.len();
            st.tags.extend(tags.iter().cloned());
            st.tags.len() != before
        };
        if created {
            self.save_tags().await?;
        }
        Ok(())
    }

    /// Create a category; 409 if it exists.
    pub(crate) async fn create_category(&self, name: &str, c: Category) -> ApiResult<()> {
        check_category_name(name)?;
        check_category_paths(&c)?;
        {
            let mut st = self.state();
            if st.categories.contains_key(name) {
                return Err(ApiError::conflict(format!("category {name:?} exists")));
            }
            st.categories.insert(name.to_string(), c);
        }
        self.save_categories().await
    }

    /// Change a category's paths; its automatically managed torrents follow.
    pub(crate) async fn edit_category(self: &Arc<Self>, name: &str, c: Category) -> ApiResult<()> {
        check_category_paths(&c)?;
        {
            let mut st = self.state();
            let slot = st
                .categories
                .get_mut(name)
                .ok_or_else(|| ApiError::not_found(format!("no category {name:?}")))?;
            *slot = c;
        }
        self.save_categories().await?;
        self.relocate_managed(Some(name)).await;
        Ok(())
    }

    /// Remove categories; their torrents lose the category (and managed ones
    /// move to the default save path).
    pub(crate) async fn remove_categories(self: &Arc<Self>, names: &[String]) -> ApiResult<()> {
        let affected: Vec<InfoHash> = {
            let mut st = self.state();
            for n in names {
                st.categories.remove(n);
            }
            let mut hit = Vec::new();
            for (h, e) in st.torrents.iter_mut() {
                if e.record
                    .category
                    .as_ref()
                    .is_some_and(|c| names.contains(c))
                {
                    e.record.category = None;
                    hit.push(*h);
                }
            }
            hit
        };
        self.save_categories().await?;
        {
            let mut st = self.state();
            for h in &affected {
                if let Some(e) = st.torrents.get_mut(h) {
                    e.dirty = true;
                }
            }
        }
        self.flush_records().await?;
        if !affected.is_empty() {
            self.relocate_managed(None).await;
        }
        Ok(())
    }

    /// Create tags.
    pub(crate) async fn create_tags(&self, tags: &[String]) -> ApiResult<()> {
        self.ensure_tags(tags).await
    }

    /// Delete tags, also from every torrent.
    pub(crate) async fn delete_tags(&self, tags: &[String]) -> ApiResult<()> {
        let affected: Vec<InfoHash> = {
            let mut st = self.state();
            for t in tags {
                st.tags.remove(t);
            }
            let mut hit = Vec::new();
            for (h, e) in st.torrents.iter_mut() {
                let before = e.record.tags.len();
                e.record.tags.retain(|t| !tags.contains(t));
                if e.record.tags.len() != before {
                    hit.push(*h);
                }
            }
            hit
        };
        self.save_tags().await?;
        {
            let mut st = self.state();
            for h in &affected {
                if let Some(e) = st.torrents.get_mut(h) {
                    e.dirty = true;
                }
            }
        }
        self.flush_records().await?;
        Ok(())
    }

    /// Set a torrent's category (created if missing); managed torrents move.
    pub(crate) async fn set_category(
        self: &Arc<Self>,
        hash: InfoHash,
        id: TorrentId,
        category: Option<String>,
    ) -> ApiResult<()> {
        let category = category.filter(|c| !c.is_empty());
        if let Some(c) = &category {
            self.ensure_category(c).await?;
        }
        self.edit_record(hash, |r| r.category = category)?;
        self.relocate_one(hash, id).await;
        Ok(())
    }

    /// Change a torrent's tags.
    pub(crate) async fn change_tags(
        &self,
        hash: InfoHash,
        mode: crate::model::TagMode,
        tags: &[String],
    ) -> ApiResult<()> {
        use crate::model::TagMode;
        if mode != TagMode::Remove {
            self.ensure_tags(tags).await?;
        }
        let tags: BTreeSet<String> = tags.iter().cloned().collect();
        self.edit_record(hash, |r| match mode {
            TagMode::Add => r.tags.extend(tags),
            TagMode::Remove => r.tags.retain(|t| !tags.contains(t)),
            TagMode::Set => r.tags = tags,
        })
    }

    /// Turn automatic management on or off; on moves the torrent to its
    /// category's path.
    pub(crate) async fn set_auto_management(
        self: &Arc<Self>,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        self.edit_record(hash, |r| r.auto_management = on)?;
        if on {
            self.relocate_one(hash, id).await;
        }
        Ok(())
    }

    /// Move managed torrents whose save path no longer matches their
    /// category (all categories, or just `only`).
    pub(crate) async fn relocate_managed(self: &Arc<Self>, only: Option<&str>) {
        let targets: Vec<(InfoHash, TorrentId)> = {
            let st = self.state();
            st.torrents
                .iter()
                .filter(|(_, e)| e.record.auto_management)
                .filter(|(_, e)| only.is_none() || e.record.category.as_deref() == only)
                .map(|(h, e)| (*h, e.id))
                .collect()
        };
        for (h, id) in targets {
            self.relocate_one(h, id).await;
        }
    }

    /// Bring one managed torrent to its category's path.
    async fn relocate_one(self: &Arc<Self>, hash: InfoHash, id: TorrentId) {
        let (managed, category, current, downloading_elsewhere) = {
            let st = self.state();
            let Some(e) = st.torrents.get(&hash) else {
                return;
            };
            (
                e.record.auto_management,
                e.record.category.clone(),
                e.record.save_path.clone(),
                e.record.download_path.is_some(),
            )
        };
        if !managed {
            return;
        }
        let target = self.category_save_path(category.as_deref());
        if target == current {
            return;
        }
        if downloading_elsewhere {
            // The content moves to the save path when it completes.
            let _ = self.update_record(hash, |r| r.save_path = target).await;
        } else {
            self.spawn_move(hash, id, target, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(check_category_name("movies").is_ok());
        assert!(check_category_name("movies/hd").is_ok());
        assert!(check_category_name("").is_err());
        assert!(check_category_name("/movies").is_err());
        assert!(check_category_name("movies//hd").is_err());
        assert!(check_category_name("movies/").is_err());
        assert!(check_tag("a tag").is_ok());
        assert!(check_tag("a,b").is_err());
        assert!(check_tag(" a").is_err());
    }
}
