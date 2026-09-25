// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Build script. With the `web-ui` feature it embeds the web UI's build
//! (`frontend/dist`, or the directory in `URTORRENTD_WEB_UI_DIST`) in the
//! binary; without it, it does nothing, and building needs no Node.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, out)?;
        } else if path.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, path));
        }
    }
    Ok(())
}

fn main() -> Result<(), String> {
    println!("cargo::rerun-if-env-changed=URTORRENTD_WEB_UI_DIST");
    if std::env::var_os("CARGO_FEATURE_WEB_UI").is_none() {
        return Ok(());
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let dist = std::env::var_os("URTORRENTD_WEB_UI_DIST")
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../../frontend/dist"));
    let missing = |why: String| {
        format!(
            "the web-ui feature embeds the web UI's build from {}, but {why}: build it first \
             (`cargo xtask dist`, or `npm ci && npm run build` in frontend/)",
            dist.display()
        )
    };
    let root = dist.canonicalize().map_err(|e| missing(e.to_string()))?;
    if !root.join("index.html").is_file() {
        return Err(missing("it has no index.html".into()));
    }
    println!("cargo::rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    walk(&root, &root, &mut files)?;
    files.sort();
    let mut code = String::from(
        "/// The web UI's files: path relative to the build, contents.\n\
         pub(crate) static FILES: &[(&str, &[u8])] = &[\n",
    );
    for (rel, path) in &files {
        writeln!(
            code,
            "    ({rel:?}, include_bytes!({:?})),",
            path.display().to_string()
        )
        .map_err(|e| e.to_string())?;
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").map_err(|e| e.to_string())?);
    std::fs::write(out.join("web_ui.rs"), code).map_err(|e| e.to_string())
}
