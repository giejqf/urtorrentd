// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The `urtorrentd` binary.

use std::io::BufRead;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use urtorrentd::auth::{Credentials, hash_password};
use urtorrentd::store::{self, Store};
use urtorrentd::{Daemon, DaemonConfig, api};

/// A BitTorrent daemon on urtorrent with a typed HTTP API.
#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    /// Data directory (settings, torrents, resume data).
    #[arg(long, env = "URTORRENTD_DATA_DIR")]
    data_dir: Option<PathBuf>,
    /// Address the HTTP API listens on.
    #[arg(long, env = "URTORRENTD_API_LISTEN", default_value = "127.0.0.1:8080")]
    api_listen: SocketAddr,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the daemon (the default).
    Run,
    /// Set the API user name and password; the password is read from stdin.
    /// Use while the daemon is stopped (a running daemon changes its login
    /// through `PUT /api/v1/auth/credentials`).
    Passwd {
        /// User name.
        #[arg(long, default_value = "admin")]
        username: String,
    },
    /// Print the OpenAPI document of the HTTP API.
    Openapi,
}

fn default_data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("XDG_DATA_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(d).join("urtorrentd");
    }
    if let Some(h) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        return PathBuf::from(h).join(".local/share/urtorrentd");
    }
    PathBuf::from("urtorrentd-data")
}

async fn shutdown_signal(daemon: std::sync::Arc<Daemon>) {
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => tracing::info!("interrupted"),
        _ = term => tracing::info!("terminated"),
        _ = daemon.shutdown_requested() => {}
    }
}

async fn run(data_dir: PathBuf, api_listen: SocketAddr) -> Result<(), String> {
    let daemon = Daemon::start(DaemonConfig {
        data_dir,
        initial_settings: None,
    })
    .await
    .map_err(|e| format!("cannot start: {e}"))?;
    if let Some(pw) = daemon.temporary_password() {
        let user = daemon.auth_username();
        println!(
            "No API password is set. Log in as {user:?} with this temporary password (valid for this run): {pw}"
        );
    }
    let listener = tokio::net::TcpListener::bind(api_listen)
        .await
        .map_err(|e| format!("cannot listen on {api_listen}: {e}"))?;
    tracing::info!("API listening on http://{api_listen}{}", api::BASE);
    let app = api::router(daemon.clone());
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(daemon.clone()))
    .await;
    daemon.shutdown().await;
    served.map_err(|e| format!("API server: {e}"))
}

fn passwd(data_dir: PathBuf, username: String) -> Result<(), String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let password = line.trim_end_matches(['\r', '\n']);
    if password.chars().count() < 8 {
        return Err("the password needs at least 8 characters".into());
    }
    let store = Store::open(data_dir).map_err(|e| e.to_string())?;
    let mut creds: Credentials = store
        .load(store::AUTH)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    creds.username = username;
    creds.password_hash = Some(hash_password(password).map_err(|e| e.to_string())?);
    store.save(store::AUTH, &creds).map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);
    let result = match cli.command.unwrap_or(Command::Run) {
        Command::Openapi => {
            print!("{}", api::openapi_json());
            Ok(())
        }
        Command::Passwd { username } => passwd(data_dir, username),
        Command::Run => match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(run(data_dir, cli.api_listen)),
            Err(e) => Err(format!("cannot start the async runtime: {e}")),
        },
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e}");
            ExitCode::FAILURE
        }
    }
}
