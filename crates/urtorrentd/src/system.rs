// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The machine the daemon runs on (`GET /app/system`): CPUs, kernel,
//! memory, the open-file limit and use, and the default save path's file
//! system. Read from the kernel (`uname`, `getrlimit`, `sysinfo`,
//! `statvfs`) and `/proc`; nothing here changes anything.

use std::path::{Path, PathBuf};

use crate::model::{FileSystemInfo, SystemInfo};

/// Read the machine (blocking: `/proc` and the file system).
pub fn info(save_path: &str) -> SystemInfo {
    let limit = rustix::process::getrlimit(rustix::process::Resource::Nofile);
    SystemInfo {
        cpus: std::thread::available_parallelism()
            .map(|n| u32::try_from(n.get()).unwrap_or(u32::MAX))
            .unwrap_or(1),
        cpu_model: std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|t| cpu_model(&t)),
        kernel: rustix::system::uname()
            .release()
            .to_string_lossy()
            .into_owned(),
        memory: memory(),
        open_files_limit: limit.current,
        open_files_hard_limit: limit.maximum,
        open_files: std::fs::read_dir("/proc/self/fd")
            .ok()
            // The listing's own descriptor is one of them.
            .map(|d| {
                u64::try_from(d.count())
                    .unwrap_or(u64::MAX)
                    .saturating_sub(1)
            }),
        save_path_fs: file_system(Path::new(save_path)),
    }
}

/// The machine's memory in bytes.
// `totalram` is a C `unsigned long`: 32 bits on 32-bit machines.
#[allow(clippy::useless_conversion)]
fn memory() -> Option<u64> {
    let s = rustix::system::sysinfo();
    Some(u64::from(s.totalram).saturating_mul(u64::from(s.mem_unit))).filter(|&m| m > 0)
}

/// The CPU's model from `/proc/cpuinfo` (`model name` on x86, `Model` on
/// some ARM boards).
fn cpu_model(cpuinfo: &str) -> Option<String> {
    let field = |name: &str| {
        cpuinfo.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            (k.trim() == name)
                .then(|| v.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|v| !v.is_empty())
        })
    };
    field("model name").or_else(|| field("Model"))
}

/// The file system holding `path` (or its nearest existing parent).
pub(crate) fn file_system(path: &Path) -> Option<FileSystemInfo> {
    let mut p: PathBuf = path.to_path_buf();
    let p = loop {
        if let Ok(c) = p.canonicalize() {
            break c;
        }
        if !p.pop() {
            return None;
        }
    };
    let v = rustix::fs::statvfs(&p).ok()?;
    let mount = std::fs::read_to_string("/proc/self/mountinfo")
        .ok()
        .and_then(|t| mount_of(&t, &p));
    Some(FileSystemInfo {
        path: p.to_string_lossy().into_owned(),
        mount_point: mount.as_ref().map(|m| m.0.clone()),
        fs_type: mount.map(|m| m.1),
        total: v.f_blocks.saturating_mul(v.f_frsize),
        free: v.f_bavail.saturating_mul(v.f_frsize),
    })
}

/// The mount holding `path`, from `/proc/self/mountinfo`: the longest mount
/// point it is under, the last one mounted when several share it.
fn mount_of(mountinfo: &str, path: &Path) -> Option<(String, String)> {
    let mut best: Option<(String, String)> = None;
    for line in mountinfo.lines() {
        let Some((left, right)) = line.split_once(" - ") else {
            continue;
        };
        let (Some(point), Some(fs)) = (left.split(' ').nth(4), right.split(' ').next()) else {
            continue;
        };
        let point = unescape(point);
        if path.starts_with(&point) && best.as_ref().is_none_or(|b| point.len() >= b.0.len()) {
            best = Some((point, fs.to_string()));
        }
    }
    best
}

/// `/proc` escapes spaces, tabs, newlines and backslashes as `\ooo`.
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let octal = b
            .get(i + 1..i + 4)
            .filter(|d| d.iter().all(|c| (b'0'..=b'7').contains(c)));
        match (b[i], octal) {
            (b'\\', Some(d)) => {
                out.push((d[0] - b'0') * 64 + (d[1] - b'0') * 8 + (d[2] - b'0'));
                i += 4;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn mounts() {
        let info = "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n\
                    40 22 0:40 / /data rw shared:2 - xfs /dev/sdb1 rw\n\
                    41 22 0:41 / /data/my\\040disk rw - btrfs /dev/sdc1 rw\n\
                    42 40 0:42 / /data rw - zfs tank/data rw\n";
        let m = |p: &str| mount_of(info, Path::new(p)).unwrap();
        assert_eq!(m("/home/x"), ("/".into(), "ext4".into()));
        // The last mount over a point hides the ones before.
        assert_eq!(m("/data/a"), ("/data".into(), "zfs".into()));
        assert_eq!(
            m("/data/my disk/x"),
            ("/data/my disk".into(), "btrfs".into())
        );
        // A path component, not a prefix of one.
        assert_eq!(m("/database"), ("/".into(), "ext4".into()));
    }

    #[test]
    fn cpu_models() {
        assert_eq!(
            cpu_model("processor\t: 0\nmodel name\t: AMD EPYC  7302P 16-Core\n").as_deref(),
            Some("AMD EPYC 7302P 16-Core")
        );
        assert_eq!(
            cpu_model("Model\t\t: Raspberry Pi 4\n").as_deref(),
            Some("Raspberry Pi 4")
        );
        assert_eq!(cpu_model("processor: 0\n"), None);
    }

    #[test]
    fn this_machine() {
        let dir = tempfile::tempdir().unwrap();
        let i = info(&dir.path().join("not/yet").to_string_lossy());
        assert!(i.cpus >= 1);
        assert!(!i.kernel.is_empty());
        assert!(i.open_files.unwrap() > 0);
        let fs = i.save_path_fs.unwrap();
        assert!(fs.total >= fs.free && fs.total > 0);
        assert!(!fs.path.contains("not/yet"));
    }
}
