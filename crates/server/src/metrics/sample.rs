//! Gauges read once a minute (and on a `/metrics` scrape): storage, disk, caches, and each
//! unit's cgroup memory and CPU. Every source may be missing (a dev machine has no
//! `mapcro.service` cgroup); a missing one leaves its gauge unset rather than failing.

use super::{Cache, Unit, get};
use crate::AppState;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// A unit's cgroup directory.
fn cgroup(unit: Unit) -> PathBuf {
    use super::Label;
    Path::new("/sys/fs/cgroup/system.slice").join(format!("{}.service", unit.as_str()))
}

fn read_u64(path: &Path) -> Option<u64> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// `key value` lines (cpu.stat, memory.events, /proc/self/status).
fn field(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        (it.next()?.trim_end_matches(':') == key).then(|| it.next()?.parse().ok())?
    })
}

/// A cgroup's working set: `memory.current` less its inactive file cache, which the kernel
/// reclaims at the cap rather than killing anything (a replay download fills it). The alert
/// limit is about memory that can't be given back (the kubelet's measure).
fn working_set(current: u64, stat: &str) -> u64 {
    current.saturating_sub(field(stat, "inactive_file").unwrap_or(0))
}

/// CPU seconds used, for a rate between samples.
#[derive(Default)]
pub struct Cpu {
    last: [Option<(Instant, f64)>; 2],
}

fn cpu_seconds(unit: Unit) -> Option<f64> {
    if let Ok(stat) = std::fs::read_to_string(cgroup(unit).join("cpu.stat")) {
        return field(&stat, "usage_usec").map(|us| us as f64 / 1e6);
    }
    // No unit (development): the server's own process, utime + stime in clock ticks (100 Hz).
    if unit == Unit::Server {
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        let after = stat.rsplit_once(')')?.1;
        let f: Vec<&str> = after.split_whitespace().collect();
        let ticks = f.get(11)?.parse::<f64>().ok()? + f.get(12)?.parse::<f64>().ok()?;
        return Some(ticks / 100.0);
    }
    None
}

fn sample_unit(unit: Unit, cpu: &mut Cpu) {
    use super::Label;
    let m = get();
    let dir = cgroup(unit);
    let l = (unit,);
    match read_u64(&dir.join("memory.current")) {
        Some(v) => {
            let stat = std::fs::read_to_string(dir.join("memory.stat")).unwrap_or_default();
            m.unit_memory_bytes.set(l, working_set(v, &stat) as f64);
            if let Some(p) = read_u64(&dir.join("memory.peak")) {
                m.unit_memory_peak_bytes.set(l, p as f64);
            }
            // "max" when uncapped: no gauge.
            if let Some(max) = read_u64(&dir.join("memory.max")) {
                m.unit_memory_max_bytes.set(l, max as f64);
            }
            if let Some(oom) = std::fs::read_to_string(dir.join("memory.events")).ok().and_then(|e| field(&e, "oom_kill")) {
                m.unit_oom_kills.set(l, oom as f64);
            }
        }
        None if unit == Unit::Server => {
            // Development: the process's resident memory and its high-water mark.
            if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
                if let Some(kb) = field(&s, "VmRSS") {
                    m.unit_memory_bytes.set(l, kb as f64 * 1024.0);
                }
                if let Some(kb) = field(&s, "VmHWM") {
                    m.unit_memory_peak_bytes.set(l, kb as f64 * 1024.0);
                }
            }
        }
        None => {}
    }
    if let Some(now) = cpu_seconds(unit) {
        let at = Instant::now();
        let slot = &mut cpu.last[unit.index()];
        if let Some((then, used)) = *slot {
            let wall = at.duration_since(then).as_secs_f64();
            if wall > 0.5 && now >= used {
                m.unit_cpu_cores.set(l, (now - used) / wall);
            }
        }
        *slot = Some((at, now));
    }
}

/// Bytes in a directory's files (one level: the caches are flat).
fn dir_bytes(dir: &Path) -> Option<u64> {
    let rd = std::fs::read_dir(dir).ok()?;
    Some(rd.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
}

/// Read every sampled gauge. Blocking file reads run off the async runtime.
pub async fn sample(app: &AppState, cpu: &mut Cpu) {
    let m = get();
    m.rooms_open.set((), app.rooms.open_count() as f64);
    m.db_bytes.set((), app.store.bytes() as f64);
    m.db_max_bytes.set((), app.config.max_storage_bytes as f64);
    m.boards_max.set((), app.config.max_boards as f64);
    if let Ok(n) = app.store.board_count().await {
        m.boards_stored.set((), n as f64);
    }
    crate::replays::sample_metrics(app);
    let data = app.config.data_dir.clone();
    let mut c = std::mem::take(cpu);
    let c = tokio::task::spawn_blocking(move || {
        if let Ok(fs) = rustix::fs::statvfs(&data) {
            m.disk_free_bytes.set((), (fs.f_bavail * fs.f_frsize) as f64);
            m.disk_total_bytes.set((), (fs.f_blocks * fs.f_frsize) as f64);
        }
        for (cache, dir) in [(Cache::Replays, "replays"), (Cache::Matches, "matches")] {
            m.cache_bytes.set((cache,), dir_bytes(&data.join(dir)).unwrap_or(0) as f64);
        }
        for unit in [Unit::Server, Unit::Worker] {
            sample_unit(unit, &mut c);
        }
        c
    })
    .await
    .unwrap_or_default();
    *cpu = c;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_value_fields() {
        assert_eq!(field("usage_usec 1234\nuser_usec 1000\n", "usage_usec"), Some(1234));
        assert_eq!(field("low 0\noom 2\noom_kill 1\n", "oom_kill"), Some(1));
        assert_eq!(field("VmHWM:\t  2048 kB\n", "VmHWM"), Some(2048));
        assert_eq!(field("oom 2\n", "oom_kill"), None);
    }

    #[test]
    fn working_set_leaves_out_reclaimable_file_cache() {
        let stat = "anon 8036352\nfile 260000000\nactive_file 1000000\ninactive_file 259000000\n";
        assert_eq!(working_set(268_000_000, stat), 9_000_000);
        assert_eq!(working_set(10, "inactive_file 99\n"), 0);
        assert_eq!(working_set(5_000, ""), 5_000);
    }
}
