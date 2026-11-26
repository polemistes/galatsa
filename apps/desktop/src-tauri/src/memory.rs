// SPDX-License-Identifier: GPL-3.0-or-later

//! Memory of the whole program as the operating system sees it: this process plus
//! the web view's helper processes, summed.
//!
//! What is measured differs per operating system, because each offers a different
//! figure (see `SOURCE` below and apps/desktop/README.md):
//!
//! - Linux: PSS (proportional set size) from /proc/<pid>/smaps_rollup, for this
//!   process and all its descendants (WebKitWebProcess, WebKitNetworkProcess and
//!   any other helper). PSS divides shared pages between the processes that share
//!   them, so the sum does not count shared libraries twice. Falls back to RSS from
//!   /proc/<pid>/statm for a process whose smaps_rollup cannot be read.
//! - macOS: WKWebView's helpers (com.apple.WebKit.WebContent, .Networking, .GPU)
//!   are XPC services started by launchd, not children of the app. They are found
//!   by asking which process is "responsible" for them
//!   (responsibility_get_pid_responsible_for_pid, looked up at run time because it
//!   is not public API). Each is measured by its physical footprint
//!   (proc_pid_rusage, the figure Activity Monitor shows as "Memory"), or by its
//!   resident size if that is refused.
//! - Windows: the WebView2 processes (msedgewebview2.exe) are descendants of the
//!   app. Each is measured by its working set (resident memory); the sum counts
//!   pages shared between them more than once, so it is an upper bound.
//!
//! If a web view process cannot be found or read, the sample's total is None and
//! `problem` says why: a partial sum would understate the memory, and the
//! benchmark then reports the memory target as not judged instead of passed.
//! Memory on a dedicated graphics card (VRAM) is not included anywhere.

use serde::Serialize;
use std::time::{Duration, Instant};

/// How often the list of processes is read again to find new helper processes.
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub pid: u32,
    pub name: String,
    /// Bytes, or None if the process could not be read.
    pub bytes: Option<u64>,
    /// Which figure was read ("pss", "rss", "phys_footprint", "working_set").
    pub method: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySample {
    /// Sum over all processes, or None if any web view process is missing or
    /// unreadable.
    pub bytes: Option<u64>,
    pub processes: Vec<ProcessMemory>,
    /// Why `bytes` is None, or a note about the figure.
    pub problem: Option<String>,
}

#[cfg(target_os = "linux")]
pub const SOURCE: &str = "Linux: sum of PSS (proportional set size, /proc/<pid>/smaps_rollup; RSS where PSS cannot be read) of the app process and all its descendants (WebKitWebProcess, WebKitNetworkProcess and other WebKitGTK helpers)";
#[cfg(target_os = "macos")]
pub const SOURCE: &str = "macOS: sum of the physical footprint (proc_pid_rusage; resident size where refused) of the app process and the WebKit processes it is responsible for (com.apple.WebKit.WebContent, .Networking, .GPU)";
#[cfg(target_os = "windows")]
pub const SOURCE: &str = "Windows: sum of the working sets (resident memory) of the app process and all its descendants (msedgewebview2.exe); pages shared between processes are counted more than once";
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub const SOURCE: &str = "not supported on this operating system";

pub struct Sampler {
    pids: Vec<(u32, String)>,
    discovered_at: Option<Instant>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    system: Option<sysinfo::System>,
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            pids: Vec::new(),
            discovered_at: None,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            system: sysinfo::System::new().ok(),
        }
    }

    pub fn sample(&mut self) -> MemorySample {
        let stale = self
            .discovered_at
            .is_none_or(|at| at.elapsed() >= DISCOVERY_INTERVAL);
        if stale {
            self.pids = self.discover();
            self.discovered_at = Some(Instant::now());
        }
        let processes: Vec<ProcessMemory> = self.measure();
        // Processes that ended since the last discovery are dropped quietly; a
        // missing web view process is caught below.
        let processes: Vec<ProcessMemory> = processes
            .into_iter()
            .filter(|p| p.bytes.is_some() || p.method != "gone")
            .collect();
        let missing_webview = !processes.iter().any(|p| is_webview_process(&p.name));
        let unreadable: Vec<&ProcessMemory> =
            processes.iter().filter(|p| p.bytes.is_none()).collect();
        let problem = if missing_webview {
            Some(format!(
                "no web view process ({WEBVIEW_PROCESS_HINT}) was found for this app"
            ))
        } else if !unreadable.is_empty() {
            Some(format!(
                "could not read the memory of: {}",
                unreadable
                    .iter()
                    .map(|p| format!("{} ({})", p.name, p.pid))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        } else {
            None
        };
        let bytes = if problem.is_none() {
            Some(processes.iter().filter_map(|p| p.bytes).sum())
        } else {
            None
        };
        MemorySample {
            bytes,
            processes,
            problem,
        }
    }
}

#[cfg(target_os = "linux")]
const WEBVIEW_PROCESS_HINT: &str = "WebKitWebProcess";
#[cfg(target_os = "macos")]
const WEBVIEW_PROCESS_HINT: &str = "com.apple.WebKit.WebContent";
#[cfg(target_os = "windows")]
const WEBVIEW_PROCESS_HINT: &str = "msedgewebview2.exe";
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
const WEBVIEW_PROCESS_HINT: &str = "unknown";

/// True for the process that runs the page (where the engines' memory goes).
fn is_webview_process(name: &str) -> bool {
    if cfg!(target_os = "linux") {
        // /proc/<pid>/comm is cut to 15 characters: "WebKitWebProces".
        name.starts_with("WebKitWebProc")
    } else if cfg!(target_os = "macos") {
        name.starts_with("com.apple.WebKit.WebContent")
    } else if cfg!(target_os = "windows") {
        name.eq_ignore_ascii_case("msedgewebview2.exe")
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Linux

#[cfg(target_os = "linux")]
impl Sampler {
    fn discover(&mut self) -> Vec<(u32, String)> {
        use std::collections::HashMap;
        let me = std::process::id();
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut names: HashMap<u32, String> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let Some(pid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|s| s.parse::<u32>().ok())
                else {
                    continue;
                };
                let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                    continue;
                };
                // "pid (comm) state ppid ...": comm may contain spaces and parentheses.
                let Some(close) = stat.rfind(')') else {
                    continue;
                };
                let open = stat.find('(').unwrap_or(0);
                let comm = stat[open + 1..close].to_string();
                let mut rest = stat[close + 1..].split_whitespace();
                let _state = rest.next();
                let Some(ppid) = rest.next().and_then(|s| s.parse::<u32>().ok()) else {
                    continue;
                };
                children.entry(ppid).or_default().push(pid);
                names.insert(pid, comm);
            }
        }
        let mut out = Vec::new();
        let mut stack = vec![me];
        while let Some(pid) = stack.pop() {
            out.push((pid, names.get(&pid).cloned().unwrap_or_default()));
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids.iter().copied());
            }
        }
        out
    }

    fn measure(&mut self) -> Vec<ProcessMemory> {
        self.pids
            .iter()
            .map(|(pid, name)| {
                let (bytes, method) = linux_pss(*pid)
                    .map(|b| (Some(b), "pss"))
                    .or_else(|| linux_rss(*pid).map(|b| (Some(b), "rss")))
                    .unwrap_or_else(|| {
                        // A process that has ended is not a reading problem.
                        if std::path::Path::new(&format!("/proc/{pid}")).exists() {
                            (None, "unreadable")
                        } else {
                            (None, "gone")
                        }
                    });
                ProcessMemory {
                    pid: *pid,
                    name: name.clone(),
                    bytes,
                    method,
                }
            })
            .collect()
    }
}

#[cfg(target_os = "linux")]
fn linux_pss(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok()?;
    let line = text.lines().find(|l| l.starts_with("Pss:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

#[cfg(target_os = "linux")]
fn linux_rss(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
    let pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    // SAFETY: sysconf has no preconditions.
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    (page > 0).then(|| pages * page as u64)
}

// ---------------------------------------------------------------------------
// Windows

#[cfg(target_os = "windows")]
impl Sampler {
    fn discover(&mut self) -> Vec<(u32, String)> {
        use std::collections::HashMap;
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
        let Some(system) = self.system.as_mut() else {
            return vec![(std::process::id(), String::new())];
        };
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in system.processes() {
            if let Some(parent) = process.parent() {
                children.entry(parent).or_default().push(*pid);
            }
        }
        let me = Pid::from_u32(std::process::id());
        let mut out = Vec::new();
        let mut stack = vec![me];
        while let Some(pid) = stack.pop() {
            let name = system
                .process(pid)
                .map(|p| p.name().to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push((pid.as_u32(), name));
            if let Some(kids) = children.get(&pid) {
                // A recycled pid could make a cycle; never visit a pid twice.
                for kid in kids {
                    if !out.iter().any(|(p, _)| *p == kid.as_u32()) {
                        stack.push(*kid);
                    }
                }
            }
        }
        out
    }

    fn measure(&mut self) -> Vec<ProcessMemory> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
        let pids: Vec<Pid> = self.pids.iter().map(|(p, _)| Pid::from_u32(*p)).collect();
        let Some(system) = self.system.as_mut() else {
            return Vec::new();
        };
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        self.pids
            .iter()
            .map(|(pid, name)| {
                let process = system.process(Pid::from_u32(*pid));
                let (bytes, method) = match process.map(|p| p.memory()) {
                    Some(b) if b > 0 => (Some(b), "working_set"),
                    Some(_) => (None, "unreadable"),
                    None => (None, "gone"),
                };
                ProcessMemory {
                    pid: *pid,
                    name: name.clone(),
                    bytes,
                    method,
                }
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// macOS

#[cfg(target_os = "macos")]
type ResponsibleFn = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;

#[cfg(target_os = "macos")]
fn responsible_fn() -> Option<ResponsibleFn> {
    let name = c"responsibility_get_pid_responsible_for_pid";
    // SAFETY: dlsym with RTLD_DEFAULT and a valid C string; a null result means the
    // symbol is not there.
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if ptr.is_null() {
        None
    } else {
        // SAFETY: the symbol has this signature (pid_t -> pid_t) on every macOS
        // version that has it.
        Some(unsafe { std::mem::transmute::<*mut libc::c_void, ResponsibleFn>(ptr) })
    }
}

#[cfg(target_os = "macos")]
fn phys_footprint(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    // SAFETY: the buffer is a rusage_info_v2, matching the flavor.
    let rc = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V2,
            info.as_mut_ptr() as *mut libc::rusage_info_t,
        )
    };
    if rc != 0 {
        return None;
    }
    // SAFETY: proc_pid_rusage filled the struct.
    let info = unsafe { info.assume_init() };
    (info.ri_phys_footprint > 0).then_some(info.ri_phys_footprint)
}

#[cfg(target_os = "macos")]
impl Sampler {
    fn discover(&mut self) -> Vec<(u32, String)> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};
        let me = std::process::id();
        let mut out = vec![(me, String::from("app"))];
        let Some(system) = self.system.as_mut() else {
            return out;
        };
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let responsible = responsible_fn();
        for (pid, process) in system.processes() {
            let pid = pid.as_u32();
            if pid == me {
                out[0].1 = process.name().to_string_lossy().into_owned();
                continue;
            }
            let child = process.parent().map(|p| p.as_u32()) == Some(me);
            // SAFETY: the function takes any pid and returns a pid or -1.
            let ours = responsible
                .map(|f| (unsafe { f(pid as libc::pid_t) }) == me as libc::pid_t)
                .unwrap_or(false);
            if child || ours {
                out.push((pid, process.name().to_string_lossy().into_owned()));
            }
        }
        out
    }

    fn measure(&mut self) -> Vec<ProcessMemory> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
        let pids: Vec<Pid> = self.pids.iter().map(|(p, _)| Pid::from_u32(*p)).collect();
        if let Some(system) = self.system.as_mut() {
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
        }
        let system = self.system.as_ref();
        self.pids
            .iter()
            .map(|(pid, name)| {
                let resident = system
                    .and_then(|s| s.process(Pid::from_u32(*pid)))
                    .map(|p| p.memory());
                let (bytes, method) = match (phys_footprint(*pid), resident) {
                    (Some(b), _) => (Some(b), "phys_footprint"),
                    (None, Some(b)) if b > 0 => (Some(b), "resident"),
                    (None, Some(_)) => (None, "unreadable"),
                    (None, None) => (None, "gone"),
                };
                ProcessMemory {
                    pid: *pid,
                    name: name.clone(),
                    bytes,
                    method,
                }
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Other systems: only report that nothing can be measured.

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
impl Sampler {
    fn discover(&mut self) -> Vec<(u32, String)> {
        Vec::new()
    }
    fn measure(&mut self) -> Vec<ProcessMemory> {
        Vec::new()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn reads_own_memory() {
        let mut sampler = Sampler::new();
        let sample = sampler.sample();
        let me = sample
            .processes
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("own process listed");
        assert!(me.bytes.unwrap_or(0) > 0);
        // No web view in a unit test: the total must not be reported.
        assert!(sample.bytes.is_none());
        assert!(sample.problem.is_some());
    }
}
