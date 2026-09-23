// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The committed `openapi.json` (what frontend SDKs are generated from) must
//! be exactly what the code produces. Regenerate with
//! `UPDATE_OPENAPI=1 cargo test -p urtorrentd --test openapi` or
//! `cargo xtask openapi`.

#![allow(clippy::unwrap_used, clippy::panic, missing_docs)]

use std::path::PathBuf;

#[test]
fn committed_openapi_is_current() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi.json");
    let generated = urtorrentd::api::openapi_json();
    if std::env::var_os("UPDATE_OPENAPI").is_some() {
        std::fs::write(&path, &generated).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    if committed != generated {
        panic!(
            "openapi.json is out of date: run `cargo xtask openapi` (or \
             UPDATE_OPENAPI=1 cargo test -p urtorrentd --test openapi) and commit it"
        );
    }
}

#[test]
fn every_operation_is_typed() {
    let doc: serde_json::Value = serde_json::from_str(&urtorrentd::api::openapi_json()).unwrap();
    for (path, item) in doc["paths"].as_object().unwrap() {
        for (method, op) in item.as_object().unwrap() {
            let id = op["operationId"].as_str().unwrap_or_default();
            assert!(!id.is_empty(), "{method} {path} has no operationId");
            assert!(op["summary"].is_string(), "{method} {path} has no summary");
            let ok: Vec<&String> = op["responses"]
                .as_object()
                .unwrap()
                .keys()
                .filter(|k| k.starts_with('2'))
                .collect();
            assert_eq!(
                ok.len(),
                1,
                "{method} {path} needs exactly one success response"
            );
            for (code, resp) in op["responses"].as_object().unwrap() {
                if !code.starts_with('2') {
                    assert_eq!(
                        resp["content"]["application/json"]["schema"]["$ref"],
                        "#/components/schemas/ErrorBody",
                        "{method} {path} {code}"
                    );
                }
            }
        }
    }
    let ids: Vec<&str> = doc["paths"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|i| i.as_object().unwrap().values())
        .map(|op| op["operationId"].as_str().unwrap())
        .collect();
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        ids.len(),
        "operationIds are unique (SDK method names)"
    );
}

fn collect_refs<'a>(v: &'a serde_json::Value, out: &mut Vec<&'a str>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, x) in m {
                if k == "$ref"
                    && let Some(r) = x.as_str()
                {
                    out.push(r);
                }
                collect_refs(x, out);
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| collect_refs(x, out)),
        _ => {}
    }
}

#[test]
fn every_ref_resolves() {
    let doc: serde_json::Value = serde_json::from_str(&urtorrentd::api::openapi_json()).unwrap();
    let mut refs = Vec::new();
    collect_refs(&doc, &mut refs);
    assert!(!refs.is_empty());
    for r in refs {
        let name = r
            .strip_prefix("#/components/schemas/")
            .unwrap_or_else(|| panic!("unexpected $ref {r}"));
        assert!(
            doc["components"]["schemas"][name].is_object(),
            "$ref {r} does not resolve: register the schema in ApiDoc"
        );
    }
}
