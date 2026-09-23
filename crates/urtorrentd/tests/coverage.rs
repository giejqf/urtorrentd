// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! AGENTS.md rule 3: no feature of the reference is silently missed. Every
//! qBittorrent WebAPI action has a row in docs/api.md and every preference
//! key a row in docs/settings.md, each with a status.

#![allow(clippy::unwrap_used, missing_docs)]

use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn reference(name: &str) -> Vec<String> {
    std::fs::read_to_string(root().join("docs/reference").join(name))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| l.split('\t').next().unwrap().trim().to_string())
        .collect()
}

fn check(doc: &str, keys: &[String]) {
    let text = std::fs::read_to_string(root().join("docs").join(doc)).unwrap();
    let statuses = ["done", "setting", "fixed", "planned", "n/a", "unsupported"];
    let mut missing = Vec::new();
    for k in keys {
        let row = text.lines().find(|l| l.starts_with(&format!("| `{k}` |")));
        match row {
            None => missing.push(format!("{k}: no row")),
            Some(r) => {
                let status = r.split('|').nth(2).unwrap_or("").trim();
                if !statuses.contains(&status) {
                    missing.push(format!("{k}: unknown status {status:?}"));
                }
            }
        }
    }
    assert!(
        missing.is_empty(),
        "docs/{doc} is missing:\n{}",
        missing.join("\n")
    );
}

#[test]
fn every_reference_endpoint_is_mapped() {
    let keys = reference("qbittorrent-5.2.3-endpoints.txt");
    assert!(keys.len() > 100);
    check("api.md", &keys);
}

#[test]
fn every_reference_preference_is_mapped() {
    let keys = reference("qbittorrent-5.2.3-preferences.txt");
    assert!(keys.len() > 200);
    check("settings.md", &keys);
}
