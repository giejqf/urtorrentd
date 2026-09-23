// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `cargo xtask <command>`: developer commands (AGENTS.md section 7).
//!
//! - `check`: fmt, clippy `-D warnings`, tests, docs, cargo-deny
//! - `openapi`: regenerate `openapi.json` from the code
//! - `sdk`: generate TypeScript types from `openapi.json` and type-check a client

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn run(cmd: &mut Command, what: &str) -> Result<()> {
    eprintln!("==> {what}");
    let status = cmd
        .current_dir(root())
        .status()
        .with_context(|| format!("running {what}"))?;
    if !status.success() {
        bail!("{what} failed ({status})");
    }
    Ok(())
}

fn cargo() -> Command {
    Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
}

fn have(tool: &str, arg: &str) -> bool {
    Command::new(tool)
        .arg(arg)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn check() -> Result<()> {
    run(
        cargo().args(["fmt", "--all", "--check"]),
        "cargo fmt --check",
    )?;
    run(
        cargo().args([
            "clippy",
            "--workspace",
            "--all-targets",
            "--",
            "-D",
            "warnings",
        ]),
        "cargo clippy",
    )?;
    run(cargo().args(["test", "--workspace"]), "cargo test")?;
    run(
        cargo()
            .args(["doc", "--workspace", "--no-deps"])
            .env("RUSTDOCFLAGS", "-D warnings"),
        "cargo doc",
    )?;
    if Command::new("cargo")
        .args(["deny", "--version"])
        .output()
        .is_ok_and(|o| o.status.success())
    {
        run(cargo().args(["deny", "check"]), "cargo deny check")?;
    } else {
        eprintln!("==> cargo deny: not installed, skipped (CI runs it)");
    }
    Ok(())
}

fn openapi() -> Result<()> {
    let out = cargo()
        .args(["run", "-q", "-p", "urtorrentd", "--", "openapi"])
        .current_dir(root())
        .output()
        .context("running urtorrentd openapi")?;
    if !out.status.success() {
        bail!(
            "urtorrentd openapi failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    std::fs::write(root().join("openapi.json"), &out.stdout).context("writing openapi.json")?;
    eprintln!("==> wrote openapi.json ({} bytes)", out.stdout.len());
    Ok(())
}

fn sdk() -> Result<()> {
    if !have("npm", "--version") {
        bail!("npm is required for `xtask sdk` (Node.js 20+)");
    }
    let dir = root().join("sdk/typescript");
    if !dir.join("node_modules").exists() {
        run(
            Command::new("npm")
                .args(["ci", "--no-audit", "--no-fund"])
                .current_dir(&dir),
            "npm ci",
        )?;
    }
    eprintln!("==> npm run check (sdk/typescript)");
    let status = Command::new("npm")
        .args(["run", "-s", "check"])
        .current_dir(&dir)
        .status()
        .context("running npm")?;
    if !status.success() {
        bail!("the TypeScript SDK check failed");
    }
    Ok(())
}

fn main() -> ExitCode {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    let r = match cmd.as_str() {
        "check" => check(),
        "openapi" => openapi(),
        "sdk" => sdk(),
        _ => {
            eprintln!("usage: cargo xtask <check|openapi|sdk>");
            return ExitCode::FAILURE;
        }
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
