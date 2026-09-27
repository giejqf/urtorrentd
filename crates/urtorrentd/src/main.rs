// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The `urtorrentd` binary.

use std::io::BufRead;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use urtorrentd::auth::{Credentials, hash_password};
use urtorrentd::daemon::first_start_settings;
use urtorrentd::settings::{Settings, SettingsPatch};
use urtorrentd::store::{self, Store};
use urtorrentd::web::WebUi;
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
    /// Settings for the first start of a new data directory: a JSON object
    /// of setting fields (as `GET /api/v1/settings` names them) applied over
    /// the defaults. Ignored once the data directory has settings; a file
    /// that does not parse stops the start either way.
    #[arg(long, env = "URTORRENTD_INITIAL_SETTINGS", value_name = "FILE")]
    initial_settings: Option<PathBuf>,
    /// Serve the web UI from this directory (a build of `frontend/`)
    /// instead of the one built into the binary.
    #[arg(long, env = "URTORRENTD_WEB_UI", value_name = "DIR")]
    web_ui: Option<PathBuf>,
    /// Serve no web UI: the API only.
    #[arg(long, conflicts_with = "web_ui")]
    no_web_ui: bool,
    /// Where GeoIP downloads (DB-IP Lite, `POST /api/v1/app/geoip/download`)
    /// come from: a mirror of https://download.db-ip.com/free.
    #[arg(long, env = "URTORRENTD_GEOIP_MIRROR", value_name = "URL")]
    geoip_mirror: Option<String>,
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
    // Open event streams end on this, so the graceful shutdown of the HTTP
    // server does not wait for them.
    daemon.request_shutdown();
}

/// The `--initial-settings` file: a settings patch over a first start's
/// defaults. Unknown fields are errors, so a typo cannot pass unnoticed.
fn initial_settings(path: &Path) -> Result<Settings, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("--initial-settings {}: {e}", path.display()))?;
    let patch: SettingsPatch = serde_json::from_str(&text)
        .map_err(|e| format!("--initial-settings {}: {e}", path.display()))?;
    Ok(first_start_settings().patched(patch))
}

/// The web UI to serve: `--no-web-ui`, `--web-ui <dir>`, or the one built in.
fn web_ui(cli: &Cli) -> Result<Option<WebUi>, String> {
    if cli.no_web_ui {
        return Ok(None);
    }
    match &cli.web_ui {
        Some(dir) => WebUi::dir(dir).map(Some).map_err(|e| e.to_string()),
        None => Ok(WebUi::embedded()),
    }
}

/// Run until shut down; `Ok(true)` when the shutdown was a restart.
async fn run(
    data_dir: PathBuf,
    api_listen: SocketAddr,
    initial_settings: Option<Settings>,
    ui: Option<WebUi>,
    geoip_mirror: Option<String>,
) -> Result<bool, String> {
    let daemon = Daemon::start(DaemonConfig {
        data_dir,
        initial_settings,
        geoip_mirror,
    })
    .await
    .map_err(|e| format!("cannot start: {e}"))?;
    if let Some(pw) = daemon.temporary_password() {
        let user = daemon.auth_username();
        println!(
            "No API password is set. The first client to call POST {}/auth/setup chooses the credentials; until then, log in as {user:?} with this temporary password (valid for this run): {pw}",
            api::BASE
        );
    }
    let listener = tokio::net::TcpListener::bind(api_listen)
        .await
        .map_err(|e| format!("cannot listen on {api_listen}: {e}"))?;
    tracing::info!("API listening on http://{api_listen}{}", api::BASE);
    match &ui {
        Some(ui) => tracing::info!("web UI on http://{api_listen}/ ({})", ui.describe()),
        None => tracing::info!("no web UI: the API only"),
    }
    let app = api::router_with_ui(daemon.clone(), ui);
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal(daemon.clone()))
    .await;
    daemon.shutdown().await;
    served.map_err(|e| format!("API server: {e}"))?;
    Ok(daemon.restart_requested())
}

/// Start again after a restart request: the same program (as it was
/// invoked, so an upgraded binary is the one that starts), arguments and
/// environment, in this process. Only returns on failure.
fn re_exec() -> String {
    use std::os::unix::process::CommandExt;
    let mut args = std::env::args_os();
    let program = args
        .next()
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
        .unwrap_or_default();
    tracing::info!("restarting");
    let e = std::process::Command::new(&program).args(args).exec();
    format!("cannot restart {}: {e}", program.display())
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
    let mut cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let data_dir = cli.data_dir.take().unwrap_or_else(default_data_dir);
    let result = match cli.command.take().unwrap_or(Command::Run) {
        Command::Openapi => {
            print!("{}", api::openapi_json());
            Ok(())
        }
        Command::Passwd { username } => passwd(data_dir, username),
        Command::Run => web_ui(&cli).and_then(|ui| {
            let initial = cli
                .initial_settings
                .as_deref()
                .map(initial_settings)
                .transpose()?;
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(|e| format!("cannot start the async runtime: {e}"))?;
            let restart = rt.block_on(run(
                data_dir,
                cli.api_listen,
                initial,
                ui,
                cli.geoip_mirror.clone(),
            ))?;
            drop(rt);
            if restart { Err(re_exec()) } else { Ok(()) }
        }),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e}");
            ExitCode::FAILURE
        }
    }
}
