// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! urtorrentd: a BitTorrent daemon on the urtorrent library, controlled
//! through a typed HTTP API (see `AGENTS.md`).
//!
//! [`Daemon`] owns the engine and the daemon-side state; [`api::router`]
//! serves it over HTTP; [`api::openapi`] is the API's OpenAPI document,
//! generated from the same handlers and types.

pub mod api;
pub mod auth;
pub mod daemon;
pub mod error;
pub mod geo;
pub mod log;
pub mod model;
pub mod settings;
pub(crate) mod stats;
pub mod store;
pub mod sync;
pub mod util;

pub use daemon::{Daemon, DaemonConfig, StartError};
